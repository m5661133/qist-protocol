# AST Facts (Compiler-Verified)

MODE: regex-fallback

> Extraction mode: regex-fallback
> Project root: /Users/macmjls/Desktop/مهم/مشاريع/العقد الذكي
> Scope directory: /Users/macmjls/Desktop/مهم/مشاريع/العقد الذكي/contracts
> Extraction timestamp: 2026-07-21T22:19:23Z

## Inheritance Tree
| Contract | File | Inherits From |
|----------|------|---------------|
| MockUSDC | contracts/Mocks.sol | ERC20 |
| MockWBTC | contracts/Mocks.sol | ERC20 |
| MockFeed | contracts/Mocks.sol | IChainlinkFeed |
| MockSequencerFeed | contracts/Mocks.sol | IChainlinkFeed |
| QistTimelock | contracts/QistTimelock.sol | TimelockController |

## Function Registry
### MockUSDC (contracts/Mocks.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| decimals | public | pure | return |
| mint | external | nonpayable |  |
| decimals | public | pure | return |
| mint | external | nonpayable |  |
| setAnswer | external | nonpayable | answer,a;,false; |
| setStale | external | nonpayable | true;,secondsAgo; |
| decimals | external | view | return,dec; |
| latestRoundData | external | view |  |
| set | external | nonpayable | answer,startedAt |
| decimals | external | pure | return |
| latestRoundData | external | view |  |

### MurabahaV6 (contracts/MurabahaV6.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| initialize | internal | nonpayable | function,initialize( |
| initializeV2 | external | nonpayable | onlyOwner |
| _authorizeUpgrade | internal | nonpayable | onlyOwner |
| renounceOwnership | public | view | onlyOwner |
| addSupportedToken | internal | nonpayable | function,addSupportedToken( |
| removeSupportedToken | external | nonpayable | onlyOwner |
| getSupportedTokens | external | view | return,tokenList; |
| _registerToken | internal | nonpayable |  |
| createOffer | internal | nonpayable | function,createOffer( |
| _createOffer | internal | nonpayable | function |
| increaseOffer | external | payable | whenNotPaused,nonReentrant |
| decreaseOffer | external | nonpayable | nonReentrant |
| cancelOffer | external | nonpayable | nonReentrant |
| buy | internal | nonpayable | function,buy( |
| _buy | internal | nonpayable | function |
| healthFactor | public | view |  |
| withdrawExcessCollateral | external | nonpayable | whenNotPaused,nonReentrant |
| addCollateral | external | payable | whenNotPaused,nonReentrant |
| payInstallment | external | nonpayable | whenNotPaused,nonReentrant |
| _chargeInstallment | internal | nonpayable |  |
| earlyRepayCash | external | nonpayable | whenNotPaused,nonReentrant |
| earlyRepayWithCollateral | external | nonpayable | whenNotPaused,nonReentrant |
| isLiquidatable | public | view |  |
| _settleByCollateral | internal | nonpayable |  |
| _addActivePosition | internal | nonpayable |  |
| _removeActivePosition | internal | nonpayable |  |
| activePositionsCount | external | view |  |
| checkUpkeep | external | view |  |
| _canAutoPay | internal | view |  |
| performUpkeep | external | nonpayable | whenNotPaused,onlyKeeperOrOwner |
| performUpkeepChecked | external | nonpayable | whenNotPaused,nonReentrant |
| liquidatePositionPublic | internal | nonpayable |  |
| processInstallmentPublic | internal | nonpayable |  |
| _checkSequencer | internal | view |  |
| _tokenPriceUSDC | internal | view |  |
| _tokenValueUSDC | internal | view |  |
| _deliverToken | internal | nonpayable |  |
| withdrawETH | external | nonpayable | nonReentrant |
| pendingETH | external | view |  |
| setProtocolFee | external | nonpayable | onlyOwner |
| setBrokerageFee | external | nonpayable | onlyOwner |
| setBrokerTreasury | external | nonpayable | onlyOwner |
| setProtocolTreasury | external | nonpayable | onlyOwner |
| setKeeper | external | nonpayable | onlyOwner |
| pause | external | nonpayable |  |
| unpause | external | nonpayable |  |
| setGuardian | external | nonpayable | onlyOwner |
| setLaunchCaps | external | nonpayable | onlyOwner |
| setSequencerUptimeFeed | external | nonpayable | onlyOwner |
| emergencyWithdraw | internal | nonpayable |  |
| getOffer | external | view | return,offers[id]; |
| getPosition | external | view | return,positions[id]; |
| quotePrice | external | view |  |
| getOffersBySeller | external | view | return |
| getPositionsByBuyer | external | view | return |
| getRemainingDebt | external | view |  |
| getInstallmentAmount | external | view |  |
| estimatePurchase | internal | nonpayable | function,estimatePurchase( |

## Call Graph (External Calls)
| Source File | Line | Call Pattern |
|-----------|------|-------------|
| contracts/MurabahaV6.sol | 357 | `IERC20(saleToken).safeTransferFrom(msg.sender, address(this), amount);` |
| contracts/MurabahaV6.sol | 407 | `IERC20(o.saleToken).safeTransferFrom(msg.sender, address(this), amount);` |
| contracts/MurabahaV6.sol | 463 | `IERC20(o.collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);` |
| contracts/MurabahaV6.sol | 587 | `IERC20(p.collateralToken).safeTransferFrom(msg.sender, address(this), amount);` |
| contracts/MurabahaV6.sol | 625 | `IERC20(paymentToken).safeTransferFrom(payer, address(this), amount + autoFee);` |
| contracts/MurabahaV6.sol | 626 | `IERC20(paymentToken).safeTransfer(seller, amount);` |
| contracts/MurabahaV6.sol | 628 | `IERC20(paymentToken).safeTransfer(protocolTreasury, autoFee);` |
| contracts/MurabahaV6.sol | 645 | `IERC20(p.paymentToken).safeTransferFrom(p.buyer, address(this), debt);` |
| contracts/MurabahaV6.sol | 646 | `IERC20(p.paymentToken).safeTransfer(o.seller, debt);` |
| contracts/MurabahaV6.sol | 856 | `IERC20(token).safeTransfer(to, amount);` |
| contracts/MurabahaV6.sol | 946 | `IERC20(token).safeTransfer(protocolTreasury, amount);` |

## Modifier Definitions
| Contract | Modifier |
|----------|----------|
| MurabahaV6 | onlyKeeperOrOwner |

## Risk Score Inputs (Exact Counts)
| File | LOC | External Calls | State Writers | Payable Fns | Assembly Blocks | Unchecked Blocks |
|------|-----|---------------|---------------|-------------|----------------|-----------------|
| contracts/Mocks.sol | 48 | 0 | 11 | 0 | 0 | 0 |
| contracts/MurabahaV6.sol | 1004 | 11 | 37 | 2 | 0 | 0 |
| contracts/QistTimelock.sol | 29 | 0 | 0 | 0 | 0 | 0 |
| contracts/interfaces/IChainlinkFeed.sol | 27 | 0 | 2 | 0 | 0 | 0 |
| contracts/libraries/Errors.sol | 88 | 0 | 0 | 0 | 0 | 0 |
| contracts/libraries/MurabahaMath.sol | 100 | 0 | 0 | 0 | 0 | 0 |
| contracts/libraries/PriceLib.sol | 110 | 0 | 0 | 0 | 0 | 0 |
| contracts/libraries/TransferLib.sol | 59 | 0 | 0 | 0 | 0 | 0 |
