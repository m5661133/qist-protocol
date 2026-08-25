# Krait State Audit Candidates — MurabahaV6

## Coupled State Dependency Map
| State Variable | Coupled With | Invariant |
|---|---|---|
| position.state | _activePositionIds / _activePositionIndex | ACTIVE ⇔ present in active index; COMPLETED/LIQUIDATED ⇔ absent |
| position.collateralAmount | contract token balance | sum(active collateralAmount) ≤ contract balance of that token |
| position.paidInstallments | position.nextDueDate / position.state | each charge: paid+1, nextDue+=interval, state→COMPLETED at paid==total |
| offer.saleAmount | offer.state | saleAmount==0 ⇔ CLOSED |
| _pendingETH.balances[*] | totalPendingETH | sum(balances) == totalPendingETH (post M-03) |
| tokenConfigs[t].active | emergencyWithdraw guard | inactive token no longer protected by `active` branch (see below) |

## Mutation Matrix (key)
- **position.state → COMPLETED/LIQUIDATED**: `_chargeInstallment`(completed), `earlyRepayCash`, `_settleByCollateral`. ALL three call `_removeActivePosition`. ✓ no orphan.
- **position.state → ACTIVE (add)**: `_buy` only → `_addActivePosition`. ✓
- **collateralAmount writes**: buy(+set), addCollateral(+), withdrawExcessCollateral(−), _chargeInstallment/earlyRepayCash(→0 on complete), _settleByCollateral(→0). Each zeroing precedes/accompanies delivery. ✓
- **totalPendingETH**: `_deliverToken`(+credit), `withdrawETH`(− saturating). ✓
- **offer.saleAmount**: createOffer(set), increaseOffer(+), decreaseOffer(−, CLOSE at 0), buy(−, CLOSE at 0), cancelOffer(→0 CLOSE). ✓

## Desynchronization Analysis
**Phase 3/5 parallel-path comparison** (complete → remove index; settle → remove index; earlyRepay → remove index): all three terminal paths update BOTH position.state and the active index and zero collateralAmount before delivery. No desync found. `withdraw`-vs-`liquidate` parity holds (both zero collateral, remove from index, deliver).

**Phase 7 masking code**:
- `sellerShare = collateralForDebt > collateral ? collateral : collateralForDebt` (L682): clamp to available collateral. Underlying "invariant broken" = position is underwater (collateral < debt-worth). This is the non-recourse bad-debt case (acknowledged L-01) — seller absorbs loss; buyerRefund=0. Not a hidden desync; it is the P2P risk model. Not a finding.
- `totalPendingETH = totalPendingETH >= amount ? totalPendingETH - amount : 0` (L864): saturating guard for legacy pre-counter balances. On-chain verified zero legacy Credited events → exact. Not masking a live desync.
- performUpkeep try/catch (L760-763): swallows revert into UpkeepFailed event; keeper-only; state changes in performUpkeepChecked are atomic (revert = no-op). Not masking a broken invariant.

## Cross-Feed from Detector
- CANDIDATE-001 (emergencyWithdraw): the coupled pair `tokenConfigs.active ↔ emergencyWithdraw guard` desyncs from the intended invariant "escrowed user token is unseizable." Removing `active` silently removes the protection for non-usdc/wbtc tokens. This is the strongest state-coupling issue → carried to Critic.
- CANDIDATE-002 (removeSupportedToken → liquidation brick): coupling `tokenConfigs.active ↔ liquidation availability` — inactive collateral token blocks healthFactor eval. Admin-triggered.

No new HIGH state-desync candidates beyond the detector's.
</content>
