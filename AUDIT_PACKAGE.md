# Qist (MurabahaV6) — External Audit Package

> **Prepared for an independent security auditor.** Everything needed to begin immediately: scope, architecture, threat model, trust assumptions, known findings, and the Islamic-finance invariants that make this protocol unusual. Please read §7 (Shariah invariants) — several "bugs" a generic auditor might flag are intentional and religiously required.

**Prepared:** 2026-07-16 · **Commit for review:** latest `main` (Build 19) · **Language:** Solidity 0.8.22 (viaIR, optimizer 200, evm: paris)

---

## 1. What Qist is

An **Islamic Murabaha (cost-plus installment sale)** protocol on **Base Mainnet**. A seller who owns an asset (ETH or cbBTC) lists it; a buyer purchases it **on installments** priced in USDC, posting crypto collateral. Profit is agreed upfront (not interest), the buyer receives the underlying asset immediately, and any liquidation returns surplus collateral to the buyer. It is a **UUPS upgradeable proxy**.

This is **not** a lending pool. There is no interest, no rehypothecation, no pooled liquidity. Each Offer→Position is a bilateral sale.

---

## 2. On-chain deployment (Base, chainId 8453)

| Contract | Address | Notes |
|----------|---------|-------|
| **Proxy** (audit target, immutable) | `0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5` | ERC1967 UUPS, verified |
| **Implementation** (Build 19) | `0xB775F07634aD5e673261eD5cE6a03924DC0A0816` | verified on Basescan (active) |
| **Owner** | `0x64D738021BAe4cb9a7fd82529C2F94f61d404064` | Gnosis Safe **2-of-3** |
| **Guardian** (pause-only) | = Safe (above) | emergency `pause()` without timelock |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | payment token, 6 decimals |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | sale/collateral, 8 decimals (contract var named `wbtc` — it points to cbBTC) |
| Chainlink L2 Sequencer feed | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | staleness/uptime guard |

> **Current TVL is ~0** (only owner test positions; positions #1–17 completed/liquidated, one small test offer). The audit precedes public launch. No real user funds are at risk during the audit window.

---

## 3. Scope

| File | LOC | Priority |
|------|-----|----------|
| `contracts/MurabahaV6.sol` | 971 | **Critical** — all business logic |
| `contracts/libraries/MurabahaMath.sol` | 100 | **Critical** — installment/profit/debt math |
| `contracts/libraries/PriceLib.sol` | 109 | **High** — Chainlink pricing + sequencer + staleness |
| `contracts/libraries/TransferLib.sol` | 59 | **High** — pull-payment ETH ledger |
| `contracts/libraries/Errors.sol` | 78 | Info — custom errors |
| `contracts/interfaces/IChainlinkFeed.sol` | 27 | Info |
| `contracts/QistTimelock.sol` | ~30 | **Not yet deployed** — TimelockController wrapper, review if in budget |

**Out of scope:** `contracts/Mocks.sol` (test-only), `scripts/`, `test/`, frontend/mobile, OpenZeppelin v5 upgradeable base contracts (assumed correct).

**Dependencies:** OpenZeppelin Contracts (Upgradeable) v5 · Chainlink Automation + price feeds.

---

## 4. Architecture — Offer / Position lifecycle

```
SELLER                                    BUYER
  │ createOffer(saleToken, collToken,        │
  │   payToken, amount, profitBps,           │
  │   min/maxInstallments, interval,         │
  │   minPurchase, collateralRatio,          │
  │   autoLiquidate)                          │
  │   ── escrows sale asset ──►               │
  │                                    buy(offerId, amount, collateral,
  │                                        maxUSDC, installments, autoPay)
  │                                      ├─ pulls collateral
  │                                      ├─ prices sale via Chainlink (USDC)
  │                                      ├─ brokerage + protocol fee (from asset)
  │                                      └─ delivers net asset to buyer ──►
  │
  │   Position now ACTIVE. Buyer pays installments in USDC:
  │     payInstallment / earlyRepayCash / earlyRepayWithCollateral
  │   Collateral mgmt: addCollateral / withdrawExcessCollateral
  │
  │   Chainlink Automation (checkUpkeep/performUpkeep):
  │     - auto-pay due installment (if buyer opted in AND can pay)
  │     - auto-liquidate if healthFactor < 105% (if seller opted in)
  │   Manual fallbacks (permissionless): processInstallmentPublic / liquidatePositionPublic
  │
  │   On completion → collateral returned to buyer.
  │   On liquidation → seller paid from collateral, SURPLUS RETURNED TO BUYER.
```

**Key state:**
- `struct Offer` (L89): seller, saleToken, collateralToken, paymentToken, totalAmount, saleAmount, minPurchaseAmount, profitBps, min/maxInstallments, paymentInterval, collateralRatioBps, state, autoLiquidateEnabled
- `struct Position` (L106): offerId, buyer, tokens, saleAmount, collateralAmount, totalPayable, total/paidInstallments, paymentInterval, nextDueDate, state, autoPayEnabled
- `_activePositionIds[]` + `_activePositionIndex` — O(active) upkeep index (swap-and-pop)
- `_pendingETH` (TransferLib.Ledger) + `totalPendingETH` — pull-payment ETH liabilities
- `guardian` — emergency pause address

---

## 5. Critical constants

```
protocolFeeBps        = 200   (2%)      MAX_PROTOCOL_FEE_BPS  = 300  (3%)
brokerageFeeBps       = 50    (0.5%/side) MAX_BROKERAGE_FEE_BPS = 100 (1%)
MIN_COLLATERAL_RATIO  = 11000 (110%)    MAX_COLLATERAL_RATIO  = 20000 (200%)
LIQUIDATION_THRESHOLD = 10500 (105%)    SLIPPAGE_TOLERANCE    = 100  (1%)
GRACE_PERIOD          = 259200 (3 days) MAX_PROFIT_BPS        = 30000 (300%)
MAX_PAYMENT_INTERVAL  = 365 days        AUTO_PAY_FEE_BPS      = 30 (0.3%)
                                        AUTO_LIQUIDATE_FEE_BPS = 50 (0.5%)
USDC = 6 decimals · cbBTC = 8 decimals · ETH = address(0)
```

---

## 6. Threat model & priority questions

Please focus on these, in order:

1. **Installment / profit / debt math** (`MurabahaMath`): proportional profit across installments; rounding must never favor a user over the protocol or vice-versa in a way that drains the counterparty. Check `nextInstallment`, `remainingDebt`, `estimatePurchase`.
2. **Liquidation & collateral accounting**: `healthFactor`, `_settleByCollateral`, surplus-to-buyer correctness, the split between "overdue after GRACE" vs "undercollateralized now" (`liquidatePositionPublic`).
3. **Oracle safety on L2**: Chainlink staleness (`MAX_PRICE_AGE`), sequencer-uptime gate (`PriceLib.requireSequencerUp`), price used at buy-time (manipulation window) vs SLIPPAGE_TOLERANCE.
4. **Decimals**: USDC(6) vs ETH/cbBTC(18/8) conversions in `PriceLib` — off-by-decimals is the highest-likelihood real bug.
5. **Reentrancy / CEI**: all fund-moving fns are `nonReentrant`; verify state is updated before external calls, esp. `_deliverToken`, `withdrawETH`, `_chargeInstallment`.
6. **Pull-payment ledger** (`TransferLib` + `totalPendingETH`): can `totalPendingETH` desync from actual `_pendingETH` sum? Can `emergencyWithdraw` touch user-owed ETH? (Build 18 change — please scrutinize.)
7. **Upgrade safety**: UUPS `_authorizeUpgrade` (onlyOwner), append-only storage layout, `reinitializer` guards. New Build-18 vars appended last.
8. **Automation DoS**: `checkUpkeep` iterates only active positions; Build 18 skips non-collectible auto-pay so it can't clog the queue head. Verify no unbounded loop / griefing.
9. **Access control**: `onlyOwner` (Safe) vs `guardian` (pause only) vs `onlyKeeperOrOwner`. `pause()` is guardian-or-owner; `unpause` is owner-only — intended.
10. **Token assumptions**: only Chainlink-fed tokens + stablecoins are addable by owner; fee-on-transfer / rebasing tokens would break accounting (owner-gated, but confirm the guard).

---

## 7. Islamic-finance invariants — DO NOT flag these as bugs

These are intentional and religiously required. A generic auditor may misread them:

- **Liquidation surplus MUST return to the buyer.** Collateral only secures the debt; the protocol/seller may not keep excess. (If you find a path where surplus is retained, that IS a critical bug.)
- **GRACE_PERIOD before overdue liquidation** is deliberate leniency to the debtor (شرعي). It is not a mistake that liquidation waits.
- **Profit is proportional to installments paid**, never a fixed per-installment interest. A partial payoff must not incur "interest".
- **No cash lending.** The buyer receives the *asset* (ETH/cbBTC), never USDC cash. Payment flows one direction (USDC in), asset the other.
- **Seller must own the asset before sale** (escrowed `saleAmount`). No naked selling.
- **MAX_PROFIT_BPS = 300%** is intentionally high — Murabaha is a consensual sale; the cap exists only to block fat-finger errors, not to police the market.

**Open Shariah questions (being reviewed separately by a Shariah scholar — for your awareness, not your scope):** whether ETH/cbBTC count as "money" vs "asset" (affects riba analysis); same-asset collateral-and-purchase; early-payoff-by-collateral as debt settlement in kind. These are jurisprudential, not security.

---

## 8. Known findings (from internal automated + multi-model review, 2026-07)

Already triaged so you don't re-derive them. **Confirm our fixes and hunt for what we missed.**

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| H-01 | High | ✅ Fixed (Build 17) | Undercollateralized liquidation now immediate; GRACE applies to *overdue* only |
| H1/H2/M5 | High/Med | ✅ Fixed (Build 17) | GRACE=3d (was test 180s); sequencer feed active; initializeV2 onlyOwner |
| M-01 | Med | ✅ Fixed (Build 18) | Auto-pay head-of-queue blocking — `checkUpkeep` now skips non-collectible positions (`_canAutoPay`) |
| M-02 | Med | ✅ Closed (on-chain verified) | Pre-Build-17 positions outside active index — confirmed all legacy positions completed; index == reality |
| M-03 | Med | ✅ Fixed (Build 18) | `totalPendingETH` liability accounting; `emergencyWithdraw` can no longer touch user-owed ETH; `guardian` for instant pause |
| L-01 | Low | Open | 105% liquidation threshold is tight; non-recourse funding → possible bad debt in a sharp crash |
| L-02 | Low | Open | `MAX_PRICE_AGE = 1h` is a single constant for all feeds |
| L-03 | Low | Open (mitigated) | fee-on-transfer/rebasing tokens would break accounting — owner-gated token whitelist |
| L-04 | Low | Open | No `__gap` — safe today (append-only), risk only if a parent contract is inserted |
| L-05 | Low | Open | ETH can be stranded if `msg.value` sent on an ERC20 path |
| I-01..03 | Info | Note | enum default ACTIVE=0; `increaseOffer` token re-check; `estimatePurchase` uses regular installment |

Full register: `ai-reviews/07-final-risk-register.md`. Slither raw: `ai-reviews/slither-raw-2026-07-10.txt` (77 results, no confirmed Critical/High; mostly OZ + design).

---

## 9. Test suite

- **137 passing** (`npx hardhat test`) — comprehensive: constructor, offers, buy math, installments, collateral/HF, early repay, liquidation, Chainlink automation, admin/permissions, pause, stale price, full ETH path, pull-over-push, partial buy, self-buy block, manual fallbacks, hardening, Build-18 M-01/M-03.
- Storage-layout compatibility validated via OpenZeppelin `validateUpgrade` against the live proxy.
- Reproduce: `npm install && npx hardhat test`.

---

## 10. Trust assumptions (be adversarial about these)

- **Owner = Safe 2-of-3** can: upgrade, set fees (≤ caps), set treasuries, set keeper/guardian, pause/unpause, `emergencyWithdraw` (whenPaused, free-ETH-only), add/remove supported tokens. A **48h Timelock** above the Safe is prepared (`QistTimelock.sol`) but **not yet deployed** — please advise if you consider it a launch blocker.
- **Guardian** (currently = Safe) can only `pause()`.
- **Keeper** (Chainlink) can only `performUpkeep`; manual fallbacks are permissionless but condition-gated on-chain.
- We assume Chainlink feeds are honest but may be stale/paused (hence the guards). We assume USDC/cbBTC behave as standard ERC-20s.

---

## 10b. Owner-power restriction — trust minimization (please review)

The team wants a **trust-minimized** contract: the owner must never freeze or seize user funds.

### ✅ Implemented (Build 19 — deployed, pending Safe upgrade)

**`emergencyWithdraw(address token, uint256 amount)`** now **reverts** with `CannotWithdrawUserAsset` if the token is `address(0)` (ETH), `usdc`, `wbtc`, or any `tokenConfigs[token].active`. Only **foreign/accidentally-sent ERC-20s** are recoverable, and only to a **fixed destination = `protocolTreasury`** (the `to` parameter was removed). Rationale ([[D-056]]): user assets (ETH/USDC/cbBTC + any supported token) become **unseizable by the owner** — no "free surplus", no exception. `usdc`/`wbtc` are blocked by explicit address check (not just the `active` flag), closing a `removeSupportedToken`-then-withdraw bypass.
- **Please verify:** completeness of this guard; that no other owner path can move user principal (aside from a malicious upgrade — see roadmap); and whether `receive() external payable {}` (L258) should be removed (it lets ETH accumulate that `emergencyWithdraw` now permanently locks — intended, but confirm).
- Tests: `D-056:` cases in the suite (ETH/USDC/cbBTC blocked even with real escrow & when paused; removed-token still blocked; foreign token → treasury).

### ✅ Implemented in code (Build 20 — committed, deploy before launch)

**Guarded-launch caps** — `setLaunchCaps(maxPositionValueUSDC, maxActivePositions)` (owner). `_buy` reverts if a new position's `totalPayable` exceeds `maxPositionValueUSDC`, or if `_activePositionIds.length >= maxActivePositions`. Both default to `0` (unlimited) — dormant until set before a guarded launch. Purpose: bound max loss (≈ `maxPositionValueUSDC × maxActivePositions`) during the early low-audit-budget phase, raised after a professional audit. **Please review:** the cap points, whether escrowed offer inventory (seller-owned) should also be capped, and any bypass. Note: deployed impl is Build 19; Build 20 (dormant caps) will be deployed before launch.

### ⏳ Planned (post-audit) — please advise

1. **Pause scope** — pause must **never trap user exits**: block only new entries (`createOffer`/`buy`/`increaseOffer`), never `payInstallment`/`earlyRepay*`/`withdrawExcessCollateral`/`liquidatePositionPublic`/`withdrawETH`. Please review current `whenNotPaused` placement and advise (note the tension: pausing liquidation may be desirable during an oracle emergency).
2. **48h Timelock** above the Safe (`QistTimelock.sol`, not yet deployed) — closes the residual `setProtocolTreasury→sweep` and malicious-upgrade windows by making all owner actions announced. Advise if it's a launch blocker.
3. **Decentralization roadmap** — multisig (now) → +Timelock → eventually renounce upgradeability. The **malicious-upgrade path is the only remaining way** the owner could reach user funds; only Timelock/renounce addresses it. Advise on timing vs TVL.

---

## 11. Deliverables requested

1. Findings report (Critical→Info) with concrete exploit scenario + suggested fix per finding.
2. Confirmation (or refutation) of our H-01/H1/H2/M5/M-01/M-02/M-03 fixes.
3. Assessment of whether the 48h Timelock is required before public launch.
4. Re-review of fixes we apply in response (one round).

**Contact:** info@qist.info · **Explorer:** https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5
