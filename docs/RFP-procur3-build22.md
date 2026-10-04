# RFP جديد على Procur3 — Build 22 (للّصق)

> كل حقل: العنوان العربي = اسم الحقل، والنص تحته = ما تلصقه. ترجمة كل فقرة بين قوسين بعدها.

## Title
Qist — Islamic Murabaha Protocol on Base: Focused Security Review of Build 22 (~1,270 nSLOC, live with caps)

(قسط — مراجعة أمنية مركّزة لـ Build 22، حوالي 1,270 سطر، حيّ مع سقوف)

## Categories
Smart contract audits · Solidity

## Budget
$1,000 (قرار المالك 2026-10-04)

## Deadline (آخر موعد لاستقبال العروض)
2026-10-18

## Description
Qist is a Shariah-compliant Murabaha (cost-plus installment sale) protocol, live on Base mainnet behind a UUPS proxy owned by a 2-of-3 Safe. Sellers escrow ETH/cbBTC, buyers purchase on USDC installments against crypto collateral, with Chainlink pricing and automation. It is a bilateral sale, not a lending pool.

Build 22 (deployed 2026-10-03) adds a global custody cap with per-token custody accounting, an accounting-fault circuit breaker, a Safe-signed reconciliation path, and splits logic into four external linked libraries (CustodyLib, BuyLogic, OfferLogic, AutomationLogic).

We run a guarded launch: hard cap $20,000 total custody (current custody ≈ $480). We want a focused review now and plan a deeper engagement as caps are raised.

Scope (~1,267 nSLOC, 12 files): MurabahaV6.sol (695) + CustodyLib, BuyLogic, OfferLogic, AutomationLogic, MurabahaMath, PriceLib, PricingLib, TransferLib, MurabahaTypes, Errors, IChainlinkFeed.

Priorities: (1) custody accounting and double-counting, (2) cap bypass, (3) external library / delegatecall storage handling, (4) installment and fee math, (5) liquidation with surplus to buyer, (6) oracle safety on L2.

Readiness: 192 Hardhat tests, 22 Foundry invariant tests (custody and cap invariants, mutation-checked), fork simulation of the live upgrade 43/43, Slither/Aderyn/Krait triaged, a full audit package (AUDIT_PACKAGE.md) with threat model, known findings and Shariah invariants. All contracts verified on Basescan.

Proxy: 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5 (Base)
Implementation: 0x962DD7Ad2AaA80eFF2Ea303Ae7E901A0A39C5DE0
Repository access (private GitHub) granted to the selected auditor.

Deliverables: findings report with exploit scenarios and fixes, one re-review round of our fixes.

(الترجمة المختصرة: قسط بروتوكول مرابحة حيّ على Base. Build 22 أضاف السقف الإجمالي وعدّادات العهدة والمصالحة وأربع مكتبات. إطلاق محروس بسقف $20k والموجود حالياً حوالي $480. نبي مراجعة مركّزة الحين وأعمق لاحقاً. النطاق 12 ملف بحوالي 1,267 سطر، والأولويات: محاسبة العهدة، وتجاوز السقف، والمكتبات، والحسابات، والتصفية، والأسعار. الجاهزية: 192 اختبار و22 Foundry و43/43 محاكاة وحزمة تدقيق كاملة. المطلوب: تقرير وجولة مراجعة للإصلاحات.)

## Links
- https://basescan.org/address/0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5
- https://qist.info

## Attachment
`AUDIT_PACKAGE.md` (من مجلد العقد الذكي)

---

## رسالة قصيرة للمدققين الثلاثة من الطلب القديم (SBSecurity · KannAudits · Slot Zero)

Hello, thank you for your proposal on our July RFP. Our contract has since been upgraded to Build 22 (~1,270 nSLOC, global custody cap + four external libraries). We opened a new RFP with the updated scope and audit package. We would value an updated quote from you.

(مرحباً، شكراً على عرضكم في طلب يوليو. العقد ترقّى الحين لـ Build 22 بحوالي 1,270 سطر، وفيه السقف الإجمالي وأربع مكتبات خارجية. فتحنا طلب جديد بالنطاق والحزمة المحدّثة، ونتمنى تحدّثون عرضكم.)
