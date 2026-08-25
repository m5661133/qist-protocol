# Krait Security Audit Report

**Target**: Qist Protocol — MurabahaV6 (Islamic Murabaha installment-sale lending, UUPS upgradeable)
**Date**: 2026-07-22
**Auditor**: Krait by Zealynx Security
**Scope**: `contracts/MurabahaV6.sol`, `contracts/libraries/{PriceLib,MurabahaMath,TransferLib,Errors}.sol`, `contracts/QistTimelock.sol`
**Out of scope**: `Mocks.sol`, `interfaces/`, `test/`, `scripts/`, OZ v5 upgradeable bases (assumed correct)
**Methodology**: 4-phase analysis (Recon → Detection → State Analysis → Verification). SMALL codebase (6 files) → full treatment. Chain: Base L2. Admin: Safe 2-of-3 (+ Chainlink keeper, guardian).

## Summary
| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 1 |

The contract is mature and well-hardened: reentrancy (CEI + nonReentrant + pull ledger), oracle guards (staleness, sequencer, dynamic decimals, slippage), installment/health-factor math, active-position index, and fee/value conservation all hold up under independent tracing and match the prior Slither/Aderyn triage (0 real) and the 6 Foundry invariants. One Medium finding: an incompleteness in the D-056 owner-power restriction that the client explicitly asked to verify.

## Findings

### [KRAIT-001] emergencyWithdraw D-056 guard is incomplete — owner can seize de-listed supported collateral — MEDIUM

**File**: `contracts/MurabahaV6.sol:932-948` (guard `939-944`); enabler `removeSupportedToken:294-298`
**Category**: Access control / trust-minimization guard completeness

**Description**: The D-056 feature is designed so the owner can never seize user assets. `emergencyWithdraw` blocks `address(0)` (ETH), `usdc`, and `wbtc` by hardcoded address, and additionally blocks "any currently-active supported token" via `tokenConfigs[token].active`. The hardcoded checks close the "remove-support-then-withdraw" bypass **only for usdc/wbtc**. Every other supported collateral/sale token — e.g., **LINK**, which is in the protocol's Base configuration, and any token added in the future — is protected **solely** by the `active` flag, which the same owner controls through `removeSupportedToken`. Removing the token flips `active` to false and drops it out of the guard.

**Impact**: A malicious or compromised owner (Safe 2-of-3) can seize all escrowed collateral of any supported token other than ETH/USDC/cbBTC, directly contradicting the advertised guarantee (code comment L928-930 and AUDIT_PACKAGE §10b: "user assets … become unseizable by the owner … closing a removeSupportedToken-then-withdraw bypass"). Positions collateralized in the seized token later revert on collateral return (`_deliverToken` → insufficient balance), so the user's collateral is permanently lost. Because no timelock is deployed and `pause()` is instant (and `payInstallment`/`earlyRepay*`/`withdrawExcessCollateral` are `whenNotPaused`), buyers have **no on-chain recourse** to rescue collateral once the sequence begins.

**Exploit Trace**:
```
Initial: LINK is a supported collateral (addSupportedToken(LINK, feed, 18, false)), active=true.
         Buyers hold LINK collateral in open positions.
         emergencyWithdraw(LINK, x) currently REVERTS (active branch) → protected as intended.
1. Owner calls removeSupportedToken(LINK)      → tokenConfigs[LINK].active = false
2. Owner/guardian calls pause()                → whenPaused = true (instant; no timelock)
3. Owner calls emergencyWithdraw(LINK, bal):
      token != 0 ✓  != usdc ✓  != wbtc ✓  active == false
      → guard is FALSE → no revert → LINK.safeTransfer(protocolTreasury, bal)
4. All escrowed LINK leaves the contract. Buyers cannot earlyRepay/withdrawExcessCollateral
   (whenNotPaused). On completion/liquidation, _deliverToken(LINK,...) reverts → collateral lost.
```

**Root Cause**: The allowlist relies on the owner-mutable `active` flag as the sole protection for all non-usdc/wbtc tokens; only usdc/wbtc received hardcoded address guards, so the general "de-list then withdraw" path remains open.

**Recommendation**: Do not depend on `active` for the protection. Track actual escrowed user liabilities per token and only permit withdrawal of a true surplus, OR block any token that has ever been registered. Minimal fix: reject any token present in `tokenList` (registered), regardless of `active`:

**Vulnerable Code**:
```solidity
function emergencyWithdraw(address token, uint256 amount)
    external onlyOwner whenPaused nonReentrant
{
    if (amount == 0) revert Errors.InvalidParams();
    if (
        token == address(0) ||
        token == address(usdc) ||
        token == address(wbtc) ||
        tokenConfigs[token].active
    ) revert Errors.CannotWithdrawUserAsset();
    IERC20(token).safeTransfer(protocolTreasury, amount);
    emit EmergencyWithdrawn(token, protocolTreasury, amount);
}
```

**Suggested Fix**:
```solidity
function emergencyWithdraw(address token, uint256 amount)
    external onlyOwner whenPaused nonReentrant
{
    if (amount == 0) revert Errors.InvalidParams();
    // Reject ETH and ANY token that was ever registered as a supported asset —
    // `active` is owner-mutable, so it must NOT be the sole guard (D-056 completeness).
    if (token == address(0) || _everRegistered(token))
        revert Errors.CannotWithdrawUserAsset();
    IERC20(token).safeTransfer(protocolTreasury, amount);
    emit EmergencyWithdrawn(token, protocolTreasury, amount);
}

// where _everRegistered checks a persistent flag set in _registerToken (never cleared),
// e.g. mapping(address => bool) private _registered;  set true in _registerToken.
```
(Deploying the prepared 48h QistTimelock above the Safe further mitigates by making the sequence announced, but the code-level completeness fix is the primary remedy.)

---

## Non-findings (checked, not reported)
- **Reentrancy** (Slither `reentrancy-eth`), **arbitrary-send-erc20**, **uninitialized-local**, **unused-return**: re-confirmed FALSE POSITIVES (CEI + nonReentrant + pull ledger; `from`==p.buyer; guarded locals; recommended Chainlink sequencer pattern).
- **removeSupportedToken bricks liquidation of that token's positions**: admin-triggered footgun with no attacker path; settlement genuinely needs a live price anyway. Downgraded to a hardening note (make removeSupportedToken account for active positions; the "existing contracts unaffected" comment is misleading).
- Acknowledged/known (Gate H, not re-reported): pause traps user exits (planned fix — note it amplifies KRAIT-001), 105% threshold / non-recourse bad debt, single MAX_PRICE_AGE, no `__gap`, ETH stranded on ERC20 path, FoT tokens, cbBTC via BTC feed.

## Readiness posture
No Critical/High. Core money-path (buy, installments, liquidation, oracle, ETH ledger) is sound and matches the fuzz/static evidence; the one Medium is an owner-power completeness gap the team specifically asked to verify — worth fixing (and/or deploying the prepared Timelock) before a public, higher-TVL launch, but not a blocker for the current guarded-launch caps.
</content>
