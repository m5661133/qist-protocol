# Qist (MurabahaV6) — External Audit Package

> **Prepared for an independent security auditor.** Everything needed to begin immediately: scope, architecture, threat model, trust assumptions, known findings, and the Islamic-finance invariants that make this protocol unusual. Please read §7 (Shariah invariants) — several "bugs" a generic auditor might flag are intentional and religiously required.

**Updated:** 2026-10-03 · **Version under review:** Build 22 (live) · **Source commit:** tag `build22-deployed-src` (`c971531`) — bytecode-identical to the deployed implementation · **Language:** Solidity 0.8.22 (viaIR, optimizer 200, evm: paris)

> **What changed since the July package (Build 18/19):** Build 20 (launch caps), Build 21 (KRAIT-001 fix + admin events), and **Build 22** — a global custody cap with per-token custody accounting, an accounting-fault circuit breaker, a Safe-signed reconciliation path, and a split of logic into **four external linked libraries** to stay under EIP-170. Scope grew from ~900 to **~1,270 nSLOC**.

---

## 1. What Qist is

An **Islamic Murabaha (cost-plus installment sale)** protocol on **Base Mainnet**. A seller who owns an asset (ETH or cbBTC) lists it; a buyer purchases it **on installments** priced in USDC, posting crypto collateral. Profit is agreed upfront (not interest), the buyer receives the underlying asset immediately, and any liquidation returns surplus collateral to the buyer. It is a **UUPS upgradeable proxy**.

This is **not** a lending pool. There is no interest, no rehypothecation, no pooled liquidity. Each Offer→Position is a bilateral sale.

---

## 2. On-chain deployment (Base, chainId 8453)

| Contract | Address | Notes |
|----------|---------|-------|
| **Proxy** (audit target, immutable) | `0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5` | ERC1967 UUPS, verified |
| **Implementation** (Build 22) | `0x962DD7Ad2AaA80eFF2Ea303Ae7E901A0A39C5DE0` | verified · active since 2026-10-03 · init version 3 |
| CustodyLib (external, linked) | `0xF52113C7094f59e09f01aff2425Aaadc270F5244` | verified |
| BuyLogic (external, linked) | `0x2b307BdEBe421cb529c27736EC74143a7C1e9DDc` | verified |
| OfferLogic (external, linked) | `0x550b8Cf91D9338d578D426BACB4e9653553037A4` | verified |
| AutomationLogic (external, linked) | `0x9b459e5f6b1A5195f5Cc1f7e5B8C277D8Dc99AA3` | verified |
| **Owner** | `0x64D738021BAe4cb9a7fd82529C2F94f61d404064` | Gnosis Safe **2-of-3** |
| **Guardian** (pause-only) | = Safe | |
| **Keeper** | `0xef6F0C01C1f61a798923Baf57eb515f45d68c2e4` | EOA; `performUpkeep` only |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | payment token, 6 decimals |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 decimals (storage var is named `wbtc` — it points to cbBTC) |
| Chainlink L2 Sequencer feed | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | uptime guard |
| Previous impl (Build 21, rollback target) | `0x0C0114d6A15BBa02a7ef89894462d52eE5F283A7` | see `docs/ROLLBACK.md` |

**Live state (2026-10-03):** guarded launch. Total custody ≈ **$480** (2 open offers, 0 active positions, 18 positions historically). Caps in force:

| Cap | Value |
|---|---|
| `globalCapUSDC` (hard ceiling, all custody) | $20,000 |
| `commitmentCapUSDC` (new offers/buys; the $5k gap is a rescue reserve for `addCollateral`) | $15,000 |
| `offerCapUSDC` (sub-cap on unsold offer inventory) | $5,000 |
| `maxPositionValueUSDC` / `maxActivePositions` (Build 20) | $4,000 / 5 |
| `protocolFeeBps` / `brokerageFeeBps` | 200 (2%) / 50 (0.5% per side) |

---

## 3. Scope

nSLOC = non-blank, non-comment lines (comments are partly Arabic).

| File | nSLOC | Priority |
|------|------:|----------|
| `contracts/MurabahaV6.sol` | 695 | **Critical** — entry points, state, cap enforcement, liquidation, admin |
| `contracts/libraries/BuyLogic.sol` (external) | 125 | **Critical** — purchase quote, fees, position record |
| `contracts/libraries/CustodyLib.sol` (external) | 108 | **Critical** — exposure, solvency (I2), migration, reconciliation |
| `contracts/libraries/MurabahaMath.sol` | 50 | **Critical** — installment / profit / debt math |
| `contracts/libraries/OfferLogic.sol` (external) | 47 | **High** — offer validation + record |
| `contracts/libraries/AutomationLogic.sol` (external) | 45 | **High** — `checkUpkeep` selection, liquidatability |
| `contracts/libraries/PriceLib.sol` | 52 | **High** — Chainlink pricing, staleness, sequencer |
| `contracts/libraries/PricingLib.sol` | 23 | **High** — shared token pricing used by contract + libraries |
| `contracts/libraries/TransferLib.sol` | 25 | **High** — pull-payment ETH ledger |
| `contracts/libraries/MurabahaTypes.sol` | 41 | Medium — structs/enums shared with libraries |
| `contracts/libraries/Errors.sol` | 45 | Info |
| `contracts/interfaces/IChainlinkFeed.sol` | 11 | Info |
| **Total** | **~1,267** | |
| `contracts/QistTimelock.sol` | 10 | Optional — **not deployed** |

**Out of scope:** `contracts/Mocks.sol`, `contracts/MurabahaV6Baseline.sol` (pre-refactor reference used for behavioural diffing), `contracts/legacy/` (Build 21 source for upgrade validation), `contracts/test/`, `scripts/`, `test/`, frontend/mobile, OpenZeppelin v5 upgradeable bases (assumed correct).

**Build:** `npm install && npx hardhat compile`. Implementation size 23,740 bytes (836 below EIP-170). Libraries are linked with `unsafeAllowLinkedLibraries`; deploy/link code is in `scripts/build22-upgrade.ts`.

---

## 4. Architecture

### 4.1 Offer / Position lifecycle

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
  │   Position ACTIVE. Buyer pays installments in USDC:
  │     payInstallment / earlyRepayCash / earlyRepayWithCollateral
  │   Collateral: addCollateral / withdrawExcessCollateral
  │
  │   Automation (checkUpkeep/performUpkeep, + permissionless performUpkeepChecked):
  │     - auto-pay a due installment (buyer opted in AND it is collectible)
  │     - auto-liquidate if HF < 105% or overdue past GRACE (seller opted in)
  │   Manual fallbacks (permissionless): processInstallmentPublic / liquidatePositionPublic
  │
  │   Completion → collateral returned to buyer.
  │   Liquidation → seller paid from collateral, SURPLUS RETURNED TO BUYER.
```

### 4.2 External libraries (new in Build 22)

`CustodyLib`, `BuyLogic`, `OfferLogic`, `AutomationLogic` are **external** libraries called via `DELEGATECALL` and operate on the proxy's storage through `storage` pointers passed in. They hold no state and have no `selfdestruct`. `PricingLib`, `PriceLib`, `MurabahaMath`, `TransferLib` are internal (inlined). Library custom errors/events are emitted in the proxy context (clients use a merged ABI).

### 4.3 Global custody cap (Build 22) — please scrutinize

Every unit of value the contract holds sits in exactly one bucket:

| Bucket | Asset | In | Out | Counted |
|---|---|---|---|---|
| A. Unsold offers | saleToken | `createOffer` · `increaseOffer` | `buy` · `decreaseOffer` · `cancelOffer` | `offerCustody[token]` |
| B. Active collateral | collateralToken | `buy` · `addCollateral` | `withdrawExcess` · completion · `earlyRepay*` · liquidation | `collateralCustody[token]` |
| C. Pending ETH | ETH | failed/3rd-party `_deliverToken` | `withdrawETH` | `totalPendingETH` |
| D. Stablecoin flow | USDC | installments | same tx | not held |
| E. Untracked | donations, `receive()`, foreign tokens | direct transfer | never | excluded from the cap |

- **Exposure** = Σ over `tokenList` of (A+B[+C for ETH]) × Chainlink price, in USDC.
- `_enforceCap(kind)` runs **at the end of deposit paths only** (exits are never capped):
  1. `accountingFault` set → revert `AccountingFault()`.
  2. **I2 solvency** per token: `balanceOf(this) ≥ owed` → else revert `CustodyInsolvent`.
  3. `exposure > globalCap` → `GlobalCapExceeded` (checked first, independently).
  4. Rescue path (`addCollateral`) stops here — may use the reserve between commitment and global cap, but only while the resulting HF stays ≤ `RESCUE_HF_BPS` (150%).
  5. `commitmentCap == 0` → `NewCommitmentsPaused`; `exposure > commitmentCap` → `GlobalCapExceeded`.
  6. Offers only: unsold-offer exposure `> offerCap` → `OfferCapExceeded`.
  A cap value of `0` for `globalCap` means "disabled"; `0` for commitment/offer caps means "paused".
- **Accounting-fault breaker:** `_custodyOut` never blocks an exit. If an outflow exceeds the counter (an I1 violation), it zeroes the counter, sets `accountingFault`, emits `AccountingFaultDetected`, and lets the user leave. New deposits then revert until reconciliation.
- **Reconciliation:** `reconcileCustody(tokens[], offerValues[], collateralValues[])` — `onlyOwner whenPaused`; requires a **full** snapshot matching `tokenList` exactly, enforces I2 per token, clears the fault. Values are computed off-chain by `scripts/reconcile-custody.ts` (plan → verify on latest block with a fingerprint over `chainId, to, value, data` → execute → `MODE=ready` gate → unpause). Procedure: `docs/RECONCILE.md`.
- **Migration:** `initializeV3(caps)` (`reinitializer(3) onlyOwner`, executed atomically via `upgradeToAndCall` from the Safe) rebuilds counters from storage, rejects a duplicated `tokenList`, and enforces I2.
- Design rationale and the review history: `docs/global-cap-design.md`.

**Invariants we test:** I1 — counters equal the sum derived from offers/positions/pending ETH; I2 — balance ≥ owed per token; I7 (Foundry) — custody counters equal state after random sequences; I8 (Foundry) — no successful deposit ever leaves exposure above the applicable cap.

---

## 5. Critical constants

```
protocolFeeBps        = 200 (live)  MAX_PROTOCOL_FEE_BPS  = 300  (3%)
brokerageFeeBps       = 50  (live)  MAX_BROKERAGE_FEE_BPS = 100  (1%)
MIN_COLLATERAL_RATIO  = 11000 (110%)   MAX_COLLATERAL_RATIO = 20000 (200%)
LIQUIDATION_THRESHOLD = 10500 (105%)   SLIPPAGE_TOLERANCE   = 100   (1%)
GRACE_PERIOD          = 3 days         MAX_PROFIT_BPS       = 30000 (300%)
MIN/MAX_PAYMENT_INTERVAL = 60 s / 365 days
RESCUE_HF_BPS         = 15000 (150%)   — addCollateral may use the rescue reserve only up to this HF (rescue, not parking)
MAX_PRICE_AGE         = 1 hour         SEQUENCER_GRACE_PERIOD = 1 hour
USDC = 6 decimals · cbBTC = 8 decimals · ETH = address(0)
```

The Build-16 auto-pay / auto-liquidate surcharges (`AUTO_PAY_FEE_BPS`, `AUTO_LIQUIDATE_FEE_BPS`) are no longer part of the public interface.

---

## 6. Threat model & priority questions

In priority order:

1. **Custody accounting (new).** Can any path move value between buckets without updating the counters (I1)? Can the same unit be counted twice, or an exit be blocked by the cap/fault logic? Pay special attention to liquidation and completion paths that deliver into pending ETH, partial buys, fee splits taken from the sale asset, and `earlyRepayWithCollateral`.
2. **Cap bypass.** Any deposit path that skips `_enforceCap`, any ordering issue (check before state update), or a price move that lets a deposit slip under. The rescue path must only be reachable by `addCollateral`.
3. **External-library linking / delegatecall.** Storage-pointer correctness, any way to call a library directly that affects the proxy, and whether errors/events are surfaced correctly.
4. **Installment / profit / debt math** (`MurabahaMath`, `BuyLogic`): rounding must not drain either party. Check `nextInstallment`, `remainingDebt`, `estimatePurchase`, and fee computation.
5. **Liquidation & surplus to buyer** — `healthFactor`, `_settleByCollateral`, overdue-after-GRACE vs undercollateralized-now.
6. **Oracle safety on L2** — staleness, sequencer gate, behaviour when a feed reverts (custody exposure pricing, `checkUpkeep` isolation — GPT-13/14 fixes).
7. **Decimals** — USDC(6) vs ETH(18)/cbBTC(8).
8. **Reentrancy / CEI** — all fund-moving functions are `nonReentrant`; verify order of state updates vs `_deliverToken`, `withdrawETH`, `_chargeInstallment`, library calls.
9. **Reconciliation abuse** — what a compromised or careless Safe could do with `reconcileCustody` (it can only rewrite counters while paused and must satisfy I2 — is that enough?).
10. **Upgrade safety** — UUPS, append-only storage, `reinitializer(3)`, Build 21 ↔ 22 rollback-and-return (`docs/ROLLBACK.md`).
11. **Automation DoS / griefing** — `checkUpkeep` loop bounds, skip logic, capacity squatting (a seller filling `offerCap` with unsold offers — accepted risk, see §8).

---

## 7. Islamic-finance invariants — DO NOT flag these as bugs

- **Liquidation surplus MUST return to the buyer.** If you find a path where surplus is retained, that IS a critical bug.
- **GRACE_PERIOD before overdue liquidation** is deliberate leniency to the debtor.
- **Profit is proportional to installments**, never interest on time. Early payoff must not incur interest.
- **No cash lending.** The buyer receives the asset, never USDC.
- **Seller must own the asset before sale** (escrowed). No naked selling.
- **MAX_PROFIT_BPS = 300%** is intentionally high — only a fat-finger guard.

Open Shariah questions (reviewed separately — not your scope): ETH/cbBTC as money vs asset; same-asset collateral and purchase; early payoff in kind.

---

## 8. Known findings and their status

Internal reviews: automated tools (Slither, Aderyn, Krait), multi-model AI review, and an independent reviewer who re-ran our results from the repository. **Please confirm our fixes and hunt for what we missed.**

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| H-01, H1, H2, M5 | High/Med | ✅ Build 17 | Immediate undercollateralized liquidation; GRACE = 3 days; sequencer feed; `initializeV2` onlyOwner |
| M-01, M-03 | Med | ✅ Build 18 | Auto-pay head-of-queue blocking; `totalPendingETH` liability accounting |
| D-056 | Design | ✅ Build 19 | `emergencyWithdraw` cannot touch user assets; fixed destination = treasury |
| KRAIT-001 | Med | ✅ Build 21 | Guard used the mutable `active` flag → now checks permanent `tokenList` membership (`_everRegistered`) |
| GPT-01 | Med | ✅ Build 22 | Disabling a token no longer breaks pricing of existing positions |
| GPT-09 | Med | ✅ Build 22 | Disabling a token blocks buys from existing offers in that token |
| GPT-13/14 | Med | ✅ Build 22 | `checkUpkeep` isolates per-position pricing failures; no auto-liquidation proposed when collateral cannot be priced; installment remainders collected |
| CAP-V2-01..02, CAP-V3-01..03 | Design | ✅ Build 22 | Zero-value semantics, `initializeV3` access isolation, invariant failures not swallowed in fuzzing, coverage gaps |
| B6-UPG-01/02 | Process | ✅ | Upgrade preflight checks current implementation; cap tests distinguish 15k vs 20k |
| B6-REC-01..03 | Process | ✅ | Reconciliation verify/ready only on latest block; fingerprint binds chain/proxy/value/data |
| L-01 | Low | Open | 105% threshold is tight; non-recourse → possible bad debt in a sharp crash |
| L-02 | Low | Open | Single `MAX_PRICE_AGE = 1h` for all feeds |
| L-03 | Low | Mitigated | Fee-on-transfer/rebasing tokens break accounting — owner-gated whitelist |
| L-04 | Low | Open | No `__gap` — safe while append-only |
| L-05 | Low | Open | ETH stranded if `msg.value` sent on an ERC20 path |

**Accepted limitations of the cap (documented in `docs/global-cap-design.md` §9):** checked at entry only (price rises can push exposure above the cap); unlimited USDC approvals in wallets are outside the cap; I2 halts deposits after an exploit but does not recover funds; capacity squatting by unsold offers is bounded by `offerCap` only.

**Pause semantics (please review):** while paused, `cancelOffer`, `decreaseOffer` and `withdrawETH` remain open; installment payments, early repayment, collateral changes, automation and public liquidation are `whenNotPaused`. `reconcileCustody` and `emergencyWithdraw` require pause. We would value your view on whether more exits should stay open during a pause.

---

## 9. Verification artefacts

| Suite | Result | How |
|---|---|---|
| Hardhat unit/integration | **192 passing** | `npx hardhat test` |
| Foundry invariants (incl. I7, I8, capped campaign) | **22/22**; mutations caught | `forge test` — `docs/size-refactor-lab/FOUNDRY.md` |
| Behavioural diff vs pre-refactor baseline | 799 identical events | `docs/size-refactor-lab/REPORT.md`, `REPRODUCE.md` |
| Fork simulation of the upgrade on Base | **43/43** | `scripts/fork-upgrade-build22.ts` — `UPGRADE-SIM.md` |
| Exact Safe transaction simulated before signing | 9/9 | `scripts/simulate-safe-upgrade.ts` |
| Reconciliation scripts | 13 tests | `test/ReconcileCustody.script.test.ts` |
| Storage layout | validated against Build 21 | OZ `validateUpgrade` |

Static analysis: `تحليل-ساكن-Slither-Aderyn-2026-07-22.md` and `.audit/krait-report.md` (no confirmed Critical/High after triage).

---

## 10. Trust assumptions (be adversarial)

- **Owner = Safe 2-of-3** can: upgrade, set fees (≤ caps), set treasuries/keeper/guardian/sequencer feed, set launch and custody caps, pause/unpause, `reconcileCustody` (paused), `emergencyWithdraw` (paused, never-registered tokens only, to treasury), add/remove supported tokens. `renounceOwnership` is disabled.
- **Guardian** (= Safe) can only `pause()`.
- **Keeper** can only `performUpkeep`; `performUpkeepChecked`, `processInstallmentPublic` and `liquidatePositionPublic` are permissionless but condition-gated on-chain.
- **No timelock yet.** A malicious upgrade is the remaining path by which the owner could reach user funds. `QistTimelock.sol` (48h) exists but is not deployed — please advise whether it should precede raising the caps.
- Chainlink feeds are assumed honest but possibly stale/unavailable; USDC/cbBTC assumed standard ERC-20.

---

## 11. Deliverables requested

1. Findings report (Critical→Info) with exploit scenario and suggested fix.
2. Confirmation or refutation of the fixes in §8, with emphasis on the Build 22 custody/cap logic.
3. Opinion on pause semantics and on the timelock as a prerequisite for raising caps.
4. One re-review round of our fixes.

**Context on budget:** we are a small, guarded launch (caps above). We are looking for a focused review now and plan a deeper one as the caps are raised.

**Contact:** info@qist.info · **Explorer:** https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5
