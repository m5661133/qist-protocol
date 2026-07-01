# Qist Protocol — Islamic DeFi | التمويل الإسلامي اللامركزي

> **بدون بنك، بدون وسيط، بدون ربا** — Buy ETH or BTC in installments, on-chain, Sharia-compliant.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Network: Base Mainnet](https://img.shields.io/badge/Network-Base%20Mainnet-0052FF)](https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5)
[![Verified: BaseScan](https://img.shields.io/badge/BaseScan-Verified-brightgreen)](https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5)

🌐 **Live App:** [qist.info](https://qist.info)

---

## What is Qist? (ما هو قسط؟)

**Qist** is the first fully on-chain **Islamic DeFi (التمويل الإسلامي اللامركزي)** protocol built on Base (Ethereum L2).

It implements **Murabaha (المرابحة)** — a Sharia-compliant cost-plus sale contract — directly in a smart contract, without any bank, broker, or interest (riba/ربا).

### How it works:
1. A **Seller** lists ETH or cbBTC at a fixed profit margin (no floating rates, no interest)
2. A **Buyer** provides crypto collateral (110%–200%) and receives the asset immediately
3. The Buyer repays in **USDC installments** over a pre-agreed schedule
4. Every transaction is transparent and verifiable on [BaseScan](https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5)

**No riba. No gharar. No bank required.** Just transparent, halal DeFi.

---

## Why Islamic DeFi?

1.8 billion Muslims worldwide seek Sharia-compliant financial products. Most DeFi protocols charge **interest (riba)**, which is **forbidden (haram)** in Islam.

Qist solves this by replacing interest-based lending with a genuine **Murabaha sale structure**:
- The seller truly **owns** the asset before selling it
- The profit is **fixed** and agreed upon upfront — not a floating rate
- The buyer receives the **actual asset** (ETH/BTC), not a loan
- Excess collateral is **always returned** to the buyer (no unjust enrichment)

Keywords: `Islamic DeFi` · `halal crypto` · `Murabaha` · `Sharia-compliant DeFi` · `تمويل إسلامي` · `مرابحة` · `التمويل اللامركزي الإسلامي` · `كريبتو حلال`

---

## Smart Contract — Base Mainnet

```
Proxy (permanent):    0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5
Network:              Base Mainnet (Chain ID: 8453)
Standard:             UUPS Upgradeable Proxy (OpenZeppelin v5)
Oracles:              Chainlink ETH/USD + BTC/USD price feeds
Automation:           Chainlink Automation (optional auto-pay)
```

**[View on BaseScan →](https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5)**

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contract | Solidity ^0.8.24, UUPS Proxy |
| L2 Network | Base (Ethereum L2) |
| Price Feeds | Chainlink ETH/USD & BTC/USD |
| Automation | Chainlink Automation |
| Stablecoin | USDC (Base) |
| Crypto Assets | ETH (native) + cbBTC |
| Testing | Hardhat + TypeScript (126 tests) |

---

## Repository Structure

```
contracts/
  MurabahaV6.sol          — Core contract (Murabaha logic, UUPS Proxy)
  libraries/              — Errors, PriceLib, MurabahaMath, TransferLib
  interfaces/             — IChainlinkFeed, IERC20
  Mocks.sol               — Test tokens & price feeds
scripts/
  upgrade_base_safe.ts    — Safe upgrade script for Base Mainnet
  perform_upkeep_base.ts  — Manual Chainlink upkeep trigger
  deploy-base.ts          — Initial deployment (completed)
test/
  MurabahaV6.comprehensive.test.ts  — 126 passing tests
hardhat.config.ts         — Network config (Base Mainnet + Sepolia)
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Fill in: BASE_RPC_URL, PRIVATE_KEY

# Compile contracts
npm run compile

# Run all tests (126 passing)
npm test
```

---

## Sharia Compliance Principles

The contract enforces these Islamic finance rules at the code level:

- Seller owns the asset before the sale (saleAmount locked in contract)
- Fixed profit, agreed upfront — no floating rates, no compounding
- Buyer receives the actual asset (ETH/BTC) — not a USDC loan
- Excess collateral always returned to the buyer
- Grace period before any liquidation (3 days) — respects the debtor
- Proportional profit per installment — no unjust full-profit on early repayment

---

## Links & Community

| Platform | Link |
|----------|------|
| App | qist.info |
| Telegram | t.me/qistdefi |
| Twitter/X | x.com/QistDeFi |
| YouTube | youtube.com/@QistDeFi |
| Medium | medium.com/@qistdefi |
| Email | info@qist.info |

---

## Security

This protocol is live on Base Mainnet. A professional security audit is recommended before large-scale use. The contract has been verified on BaseScan and tested with 126 unit tests covering ETH, cbBTC, liquidation, time-based scenarios, and Chainlink automation.

---

## License

MIT

---

Qist — التمويل الإسلامي اللامركزي على Base Blockchain
