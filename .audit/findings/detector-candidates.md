# Krait Detector Candidates — MurabahaV6

Detection over all 6 in-scope files (SMALL codebase → full treatment). Function-State matrix built; Feynman interrogation + lending/oracle/access modules applied. Slither/Aderyn used as additional signal (prior full triage confirmed 0 real). Below are the surviving CANDIDATES worth Critic scrutiny; the long tail of checked-and-clean areas is summarized at the end.

---

### [CANDIDATE-001] emergencyWithdraw D-056 guard is incomplete — de-listed supported token can be seized
**Severity**: MEDIUM
**File**: contracts/MurabahaV6.sol
**Lines**: 932-948 (guard 939-944), interacts with removeSupportedToken 294-298
**Category**: Access control / trust-minimization guard completeness

**Discovery Method**: Access-control module §1 + Feynman Q1.4 "is this check SUFFICIENT?" + AUDIT_PACKAGE §10b explicit request to "verify completeness of this guard."

**Description**: `emergencyWithdraw` is designed (D-056) so the owner can NEVER move user assets. It blocks `address(0)` (ETH), `usdc`, `wbtc` by hardcoded address, plus "any active supported token" via `tokenConfigs[token].active`. `usdc`/`wbtc` are blocked by explicit address so a "remove-then-withdraw" bypass is closed *for them only*. Every OTHER supported collateral/sale token (e.g., LINK — listed in the protocol's Base config) is protected ONLY by the `active` flag, which the same owner controls via `removeSupportedToken`.

**Scenario**:
1. Buyers open positions posting LINK collateral (LINK added via addSupportedToken; active=true → emergencyWithdraw(LINK) reverts, protected).
2. Owner (Safe) calls `removeSupportedToken(LINK)` → `tokenConfigs[LINK].active = false`.
3. Owner calls `pause()` (guardian/owner, instant — no timelock deployed).
4. Owner calls `emergencyWithdraw(LINK, contractLinkBalance)`: token != 0, != usdc, != wbtc, `active`==false → guard is FALSE → does not revert → transfers ALL escrowed LINK to protocolTreasury.
5. Result: user LINK collateral seized; affected positions later revert on `_deliverToken(LINK,...)` (insufficient balance) → collateral permanently lost. During pause, buyers cannot earlyRepay/withdrawExcessCollateral (whenNotPaused) to rescue.

**Vulnerable Code**:
```solidity
if (
    token == address(0) || token == address(usdc) ||
    token == address(wbtc) || tokenConfigs[token].active
) revert Errors.CannotWithdrawUserAsset();
IERC20(token).safeTransfer(protocolTreasury, amount);
```

**Why This Is a Bug**: The protocol's own comment (L928-930) and AUDIT_PACKAGE §10b claim "user assets (ETH/USDC/cbBTC + any supported token) become unseizable" and that the remove-then-withdraw bypass is closed. It is closed only for usdc/wbtc; the guarantee fails open for every other supported token. The threat model INCLUDES a malicious owner (that is the entire purpose of D-056), so this is a correctness gap in a security control, not generic centralization.

**Step Execution**: Lens A=✓ B=✓ C=✗(no external protocol) D=✓
**Rules Applied**: R10:✓(worst state = LINK positions open), R11:✓(external token = LINK), R12:✓(3-step enabler chain confirmed reachable), R15:✗, R16:✗
**Depth Evidence**: [TRACE: removeSupportedToken(LINK)→active=false → emergencyWithdraw(LINK) guard=false → safeTransfer executes], [VARIATION: token=usdc→blocked by address; token=LINK→not blocked]
**Missing Precondition**: none currently (no timelock deployed; pause is instant)
**Precondition Type**: ACCESS
**Who Benefits**: malicious/compromised owner (Safe)
**Status**: UNVERIFIED — needs Critic validation

---

### [CANDIDATE-002] removeSupportedToken bricks liquidation of positions collateralized in that token
**Severity**: LOW (admin-triggered)
**File**: contracts/MurabahaV6.sol
**Lines**: 294-298 (removeSupportedToken) × 551-557/667-673/791-804 (healthFactor→_tokenValueUSDC→revert on !active)
**Category**: DoS / liquidation robustness

**Description**: `liquidatePositionPublic` and `performUpkeepChecked`/`isLiquidatable` evaluate `healthFactor(positionId)` unconditionally. `healthFactor` → `_tokenValueUSDC(collateralToken)` reverts if `tokenConfigs[collateralToken].active == false`. If the owner removes support for an in-use collateral token, even OVERDUE (time-based) positions cannot be liquidated. The removeSupportedToken comment ("existing contracts unaffected") is inaccurate. NOTE: settlement `_settleByCollateral` also needs the collateral price to split collateral, so a stale-feed/removed-token state fundamentally cannot settle fairly.

**Step Execution**: Lens A=✓ B=✓ C=✓ D=✓
**Rules Applied**: R10:✓, R16:✓(same eager-eval also reverts on stale feed / sequencer-down — but that is the guard working as intended)
**Depth Evidence**: [TRACE: healthFactor eager-eval → _tokenValueUSDC → revert TokenNotSupported before overdue branch acts]
**Who Benefits**: nobody (admin footgun; no attacker path)
**Status**: UNVERIFIED

---

### Checked-and-clean (invariants verified, ≥3 edge cases each)
- **Reentrancy**: all value-moving entry points nonReentrant + CEI; only `.call` is to msg.sender last (buy/decrease/cancel), others use pull ledger. withdrawETH CEI in TransferLib. Edge: ETH-collateral buy, ETH-sale delivery, settlement refund — all guarded. (matches prior reentrancy-eth FP triage)
- **arbitrary-send-erc20** (`_chargeInstallment`/`earlyRepayCash` transferFrom from p.buyer): guarded by msg.sender==p.buyer or voluntary autoPay allowance; funds pay buyer's own debt. FP.
- **Fee/value conservation** in `_buy`: sellerFee+buyerFee+protocolFee+netToBuyer==purchaseAmount; offer decremented by gross. Conserved (matches Foundry invariant). Edge: fee/totalPayable rounding to 0 only at sub-gwei ETH dust → Gate F.
- **Installment math** (MurabahaMath): last installment == remainingDebt exactly; mul-before-div; no div-by-zero (totalInstallments>0 enforced at offer). Edge: paid=n-1, n=1, n=255.
- **Health factor / withdrawExcessCollateral**: floor MIN_COLLATERAL_RATIO 110% > LIQUIDATION 105%; debt shrinks with installments so HF rises. Symmetric with addCollateral.
- **Oracle** (PriceLib): staleness (updatedAt+1h), answer<=0, sequencer up+1h grace, dynamic feed decimals, usdcToAsset price==0 guard, slippage on sale price. Stablecoin hardcoded 1e6 (no feed). Edge: feedDecimals<6, ==6, >6.
- **Active-position index** (M-01): every COMPLETED/LIQUIDATED transition calls _removeActivePosition; swap-and-pop with index+1 sentinel; double-remove safe. add only in _buy.
- **totalPendingETH** (M-03): credited on both push-fail and pull paths; saturating decrement on withdraw. Foundry invariant totalPendingETH==0 holds.
- **Self-buy** blocked (FB-31); **self-liquidation** carries no bonus (settle returns debt-worth to seller, rest to buyer) → no self-liq profit.
- **Permissionless** liquidatePositionPublic/processInstallmentPublic: condition-gated on-chain; no caller reward; settle refunds buyer excess → no griefing/over-seizure.
- **Init/UUPS**: _disableInitializers in constructor; initialize `initializer`; initializeV2 `reinitializer(2) onlyOwner`; _authorizeUpgrade onlyOwner; renounceOwnership disabled.
- **QistTimelock**: thin OZ TimelockController subclass, no overrides — inherits audited behavior.
</content>
