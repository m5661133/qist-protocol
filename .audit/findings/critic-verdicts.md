# Krait Critic Verdicts — MurabahaV6

## Summary
- Total candidates reviewed: 2 (+ prior static-analysis FPs re-confirmed)
- True Positives: 1 (MEDIUM)
- Downgraded: 0
- False Positives / Killed: 1 (LOW admin-footgun) + prior static FPs
- Insufficient Evidence: 0

---

## Verified Findings

### [KRAIT-001] emergencyWithdraw D-056 guard incomplete — de-listed supported token seizable (was CANDIDATE-001)

**Verdict**: TRUE POSITIVE
**Severity**: MEDIUM
**File**: contracts/MurabahaV6.sol:932-948 (guard 939-944); enabler removeSupportedToken:294-298

**Verification Method**: Hybrid (code trace + concrete trace).

**Kill-gate analysis**:
- Gate E (Admin trust): The default kill for "malicious owner" does NOT dispose of this. The protocol's D-056 feature EXISTS precisely to remove owner-trust over user funds; the owner is inside this feature's threat model. Reporting an incompleteness in that control is a correctness finding, not generic centralization FUD. The client (AUDIT_PACKAGE §10b) explicitly requested verification of THIS guard's completeness and asserts the remove-then-withdraw bypass is closed. It is closed only for usdc/wbtc. → survives E as a documented-control-correctness bug (Medium).
- Gate H (Known): NOT a match — the docs claim this bypass is CLOSED (mechanism = "closed"); the finding proves it is OPEN for non-usdc/wbtc tokens. Different mechanism/outcome → not killed.
- Gates A/B/C/D/F/G: N/A (concrete, named in-scope token LINK, real value, in-scope file).

**Proof**:
```
Initial: LINK added as collateral (addSupportedToken(LINK, feed, 18, false)); active=true.
         Positions hold LINK collateral; emergencyWithdraw(LINK) currently reverts (active branch). Protected.
1. Owner calls removeSupportedToken(LINK)          → tokenConfigs[LINK].active = false
2. Owner (or guardian) calls pause()               → whenPaused true (instant; no timelock deployed)
3. Owner calls emergencyWithdraw(LINK, balance):
     token != address(0) ✓  token != usdc ✓  token != wbtc ✓  active == false
     → guard condition FALSE → no revert → IERC20(LINK).safeTransfer(protocolTreasury, balance)
4. Escrowed LINK collateral leaves the contract. Affected positions later revert in
   _deliverToken(LINK,...) on completion/liquidation → user collateral permanently lost.
   During pause, buyers CANNOT earlyRepay/withdrawExcessCollateral (whenNotPaused) to rescue.
```

**Impact**: Owner can seize all escrowed collateral of any supported token other than ETH/USDC/cbBTC (LINK today; any future added collateral). Directly contradicts the advertised "user assets unseizable" (D-056) guarantee. No user recourse (pause blocks exits; no timelock deployed).

**Root Cause**: The allowlist uses the owner-mutable `active` flag as the sole protection for non-usdc/wbtc tokens; usdc/wbtc got hardcoded address guards but the general case did not.

**Step Execution**: Gates: A=✓ B=✓ C=✓ D=✓ E=✓(survives as control-correctness) F=✓ G=✓ H=✓
**Rules Applied**: R10:✓(worst state LINK positions open), R11:✓(LINK), R12:✓(3-step chain reachable, all owner-callable now), R15:✗, R16:✗
**Depth Evidence**: [TRACE: active=false → guard false → safeTransfer executes], [VARIATION: usdc blocked by address vs LINK not blocked]
**Who Benefits**: malicious/compromised owner (Safe 2-of-3)

---

## Eliminated / Downgraded

### CANDIDATE-002: removeSupportedToken bricks liquidation
**Verdict**: FALSE POSITIVE (as a standalone vuln) — retained as operational caution only.
**Reason**: FP pattern FP-6 (severity) + Gate E. Requires owner to remove a token that has active positions (admin action, no attacker path). Furthermore, `_settleByCollateral` fundamentally needs the collateral price to fairly split collateral, so settlement genuinely cannot proceed without a live price regardless of the eager-eval; the revert is largely the staleness guard doing its job (Gate C). Same eager-eval also reverts on stale feed / sequencer-down — which is INTENDED (do not settle at an unreliable price). Net: not an exploitable finding. Documented as a hardening note (make removeSupportedToken account for active positions / fix the misleading "existing contracts unaffected" comment).
**Missing Precondition**: needs owner to de-list an in-use token; no permissionless trigger.

### Prior static-analysis findings (re-confirmed FALSE POSITIVE)
- `arbitrary-send-erc20` (_chargeInstallment/earlyRepayCash): FP-1 — `from` is always p.buyer (msg.sender==p.buyer enforced, or voluntary autoPay allowance); funds settle buyer's own debt.
- `reentrancy-eth` (_buy/_settleByCollateral): FP-3/FP — nonReentrant + CEI; only `.call` to msg.sender is the last interaction; others pull-pattern.
- `uninitialized-local` (col): FP — assigned and used only inside `if (completed)`.
- `unused-return` (requireSequencerUp): FP-10 — recommended Chainlink L2 pattern; only up/startedAt needed.
- Aderyn H-1 (withdrawETH ETH no address check): FP — sends caller their own pull-ledger balance. H-2 (Errors name reuse): framework noise, N/A under Hardhat/solc.

### Sub-threshold (not reported as findings)
- Fee/totalPayable rounding to 0 only at sub-gwei ETH dust → Gate F.
- ETH stranded if msg.value sent on ERC20 path → acknowledged L-05 (Gate H), user-error, no attacker profit.
- Pause traps user exits (payInstallment/earlyRepay/withdrawExcessCollateral are whenNotPaused) → acknowledged planned fix §10b#1 (Gate H). Note: it AMPLIFIES KRAIT-001 (no rescue during seize).
- 105% liquidation threshold / non-recourse bad debt → acknowledged L-01 (Gate H).
- WBTC/BTC-feed depeg for cbBTC → intended token assumption (Gate C, §10).
</content>
