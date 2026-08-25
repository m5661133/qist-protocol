# Krait Recon Report — MurabahaV6 (Qist Protocol)

## Protocol Overview
- **Name**: Qist / MurabahaV6 — Islamic Murabaha (installment-sale) lending
- **Type**: Lending (peer-to-peer bilateral offer/position, crypto collateral + liquidation)
- **Chain**: Base (L2)
- **Pattern**: UUPS upgradeable proxy (OZ v5 upgradeable)
- **Dependencies**: OpenZeppelin v5 (SafeERC20, ReentrancyGuard, Ownable/Pausable/UUPS-upgradeable, TimelockController), Chainlink (price feeds + L2 sequencer uptime + Automation keeper)
- **Compiler**: ^0.8.22 (solc 0.8.22, viaIR, optimizer 200, evmVersion paris)
- **Scope size**: 6 in-scope files, ~1390 LOC total (MurabahaV6 ~1004, libs ~357, QistTimelock 29)
- **Admin model**: Owner = Safe 2-of-3; guardian (pause-only) = Safe; keeper = Chainlink; 48h QistTimelock prepared but NOT yet deployed.

## File Risk Table (Detection follows this)
| Rank | File | RISK | Tier | LOC | Ext Calls | State Writers | Notes |
|------|------|------|------|-----|-----------|---------------|-------|
| 1 | contracts/MurabahaV6.sol | ~180 | DEEP | 1004 | many | ~25 | All funds, offers/positions, liquidation, admin, oracle reads, ETH+ERC20 |
| 2 | contracts/libraries/PriceLib.sol | ~55 | DEEP | 110 | 2 (feed) | 0 (pure/view) | Chainlink staleness/sequencer/decimals + slippage |
| 3 | contracts/libraries/MurabahaMath.sol | ~35 | STANDARD | 100 | 0 | 0 (pure) | Selling price, installments, remaining debt, health factor |
| 4 | contracts/libraries/TransferLib.sol | ~30 | STANDARD | 59 | 1 (.call) | ledger | Pull-pattern ETH ledger |
| 5 | contracts/libraries/Errors.sol | ~5 | SCAN | 88 | 0 | 0 | Custom errors only |
| 6 | contracts/QistTimelock.sol | ~10 | SCAN | 29 | 0 | 0 | Thin OZ TimelockController subclass, no overrides |

Codebase size category: **SMALL (≤15)** → all files get full treatment.

## Fund Flows
- **In**: seller deposits saleToken (ETH/cbBTC) via createOffer/increaseOffer; buyer deposits collateral (ETH/cbBTC/LINK) via buy/addCollateral; buyer pays USDC installments (transferFrom buyer→contract→seller).
- **Out**: buyer receives netToBuyer saleToken on buy; fees → brokerTreasury/protocolTreasury; seller receives USDC installments directly; collateral returned to buyer on completion/early-repay/refund; seller receives collateral-for-debt on settle/liquidate; ETH exits via pull ledger (withdrawETH).
- **Escrow**: contract holds offer inventory (seller-owned) + collateral (buyer-owned) + pending ETH ledger.

## Trust Boundaries
- **Owner (Safe 2-of-3)**: upgrade, set fees (≤caps), set treasuries, keeper, guardian, add/removeSupportedToken, setLaunchCaps, setSequencerFeed, pause/unpause, emergencyWithdraw (whenPaused). No timelock deployed yet.
- **Guardian (Safe)**: pause() only.
- **Keeper (Chainlink)**: performUpkeep only.
- **Permissionless (condition-gated on-chain)**: buy, liquidatePositionPublic, processInstallmentPublic, withdrawETH, checkUpkeep.
- **External data trusted-but-guarded**: Chainlink price feeds (staleness 1h, answer>0), L2 sequencer uptime (1h recovery grace).

## Attack Surface Priority
1. Liquidation / settlement math (`_settleByCollateral`, health factor) — collateral seizure fairness, bad-debt.
2. Oracle path (`PriceLib`) — staleness, sequencer, decimals, slippage.
3. Owner-power trust-minimization guards (D-056 emergencyWithdraw, launch caps) — completeness (client explicitly requested verification).
4. Buy accounting / fee conservation.
5. ETH pull-ledger accounting (totalPendingETH).

## Novel Code (not from libraries)
All of MurabahaV6 business logic; PriceLib/MurabahaMath/TransferLib custom libs. Standard bases (OZ upgradeable) assumed correct.

## Detection Primer
Loaded: `primers/defi-lending.md`

## Activated Modules
| Module | Trigger Evidence |
|--------|-----------------|
| access-control-state.md | Always active; onlyOwner/onlyKeeperOrOwner/guardian roles, UUPS init |
| oracle-analysis.md | PriceLib.latestRoundData, sequencer feed, priceUSDC consumers |
| lending-liquidation-deep.md | buy/liquidate/health-factor/collateral/grace |
| economic-design.md | fees (brokerage/protocol/auto), profit bps, liquidation split |
| token-flow-tracing.md | safeTransfer/transferFrom, ETH .call, pending ledger |
| flash-loan-interaction.md | collateral valuation via oracle at buy/settle |
| multi-tx-attack.md | offer→buy→installments→liquidate sequences |

## Prior Work (context, independently re-verified)
- Slither v0.11.5 + Aderyn v0.6.8: 77/94 + 16 results, all triaged FP/intentional (arbitrary-send-erc20, reentrancy-eth, uninitialized-local, unused-return) — re-confirmed FP.
- 6 Foundry invariants over 18k calls hold (solvency, USDC-not-retained, totalPendingETH=0, installment/offer integrity, settlement conservation).
- Known/acknowledged (Gate H): H-01/H1/H2/M5/M-01/M-02/M-03 fixed; L-01 (105% tight/bad-debt), L-02 (single MAX_PRICE_AGE), L-03 (FoT tokens owner-gated), L-04 (no __gap), L-05 (ETH stranded on ERC20 path), pause-traps-exits (planned fix), 48h Timelock not deployed.

## Relevant Checklists
Lending: oracle manipulation/staleness/sequencer/zero-price; liquidation profitability & fairness; interest/rounding (here: proportional profit, no compounding); self-liquidation; bad debt (non-recourse P2P). Chainlink: staleness+heartbeat, zero/negative, L2 sequencer, WBTC/BTC depeg.
</content>
</invoke>
