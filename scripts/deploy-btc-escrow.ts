import { ethers, upgrades, network } from "hardhat";

/**
 * نشر BtcEscrowMurabaha (مسار البيتكوين الحقيقي غير الوصائي) كـ UUPS Proxy.
 *
 * يعمل على ثلاث شبكات:
 *   - hardhat / localhost : ينشر Mocks (USDC + BTC/USD feed + Sequencer) ثم العقد — للتحقق والتجربة.
 *   - base-sepolia        : عناوين اختبارية (تحقّق منها قبل الاستخدام أو مرّرها عبر env).
 *   - base                : عناوين Mainnet الحقيقية.
 *
 * التشغيل:
 *   npx hardhat run scripts/deploy-btc-escrow.ts                      # محلي (mocks)
 *   npx hardhat run scripts/deploy-btc-escrow.ts --network base-sepolia
 *   npx hardhat run scripts/deploy-btc-escrow.ts --network base
 */

// ── عناوين لكل شبكة ────────────────────────────────────────────────────────
type NetCfg = { usdc: string; btcUsd: string; sequencer: string };
const ADDRS: Record<string, NetCfg> = {
  base: {
    usdc:      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Circle native USDC
    btcUsd:    "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", // Chainlink BTC/USD
    sequencer: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433", // L2 Sequencer Uptime
  },
  // ⚠️ عناوين Base Sepolia — تحقّق منها من توثيق Chainlink/Circle قبل النشر، أو مرّرها عبر env.
  "base-sepolia": {
    usdc:      process.env.BS_USDC      || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    btcUsd:    process.env.BS_BTC_USD   || "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298",
    sequencer: process.env.BS_SEQUENCER || "", // قد لا يوجد feed رسمي على التستنت — مرّر mock إن لزم
  },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  console.log("\n════════════════════════════════════════════");
  console.log("  نشر BtcEscrowMurabaha");
  console.log("════════════════════════════════════════════");
  console.log("الشبكة :", net);
  console.log("الناشر :", deployer.address);

  let cfg: NetCfg;

  if (net === "hardhat" || net === "localhost") {
    // نشر Mocks للتجربة المحلية
    console.log("\n🧪 شبكة محلية — نشر Mocks...");
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const btcFeed = await (await ethers.getContractFactory("MockFeed")).deploy(6_000_000_000_000n, 8); // $60k
    const seqFeed = await (await ethers.getContractFactory("MockSequencerFeed")).deploy(0, 1);          // up
    cfg = {
      usdc: await usdc.getAddress(),
      btcUsd: await btcFeed.getAddress(),
      sequencer: await seqFeed.getAddress(),
    };
  } else {
    cfg = ADDRS[net];
    if (!cfg) throw new Error(`لا توجد عناوين معرّفة للشبكة: ${net}`);
    if (!cfg.sequencer) throw new Error("عنوان Sequencer feed مفقود — مرّره عبر env (BS_SEQUENCER).");
    const bal = await ethers.provider.getBalance(deployer.address);
    console.log("الرصيد :", ethers.formatEther(bal), "ETH");
    if (bal < ethers.parseEther("0.003")) throw new Error("رصيد غير كافٍ للنشر");
  }

  // الأدوار: على التستنت/المحلي كلها = الناشر. على Mainnet غيّرها لـ Safe/HSM.
  const owner    = process.env.OWNER_ADDR    || deployer.address; // يُنصح Safe 2-of-3
  const attestor = process.env.ATTESTOR_ADDR || deployer.address; // خدمة qist-btc
  const arbiter  = process.env.ARBITER_ADDR  || deployer.address; // محكّم قسط
  const treasury = process.env.TREASURY_ADDR || deployer.address;
  const protocolFeeBps = Number(process.env.PROTOCOL_FEE_BPS || 100);

  console.log("\n📋 المعطيات:");
  console.log("  USDC      :", cfg.usdc);
  console.log("  BTC/USD   :", cfg.btcUsd);
  console.log("  Sequencer :", cfg.sequencer);
  console.log("  owner/attestor/arbiter/treasury:", owner, attestor, arbiter, treasury);
  console.log("  protocolFeeBps:", protocolFeeBps);

  console.log("\n🚀 نشر UUPS Proxy...");
  const Factory = await ethers.getContractFactory("BtcEscrowMurabaha");
  const proxy = await upgrades.deployProxy(
    Factory,
    [owner, cfg.usdc, cfg.btcUsd, cfg.sequencer, attestor, arbiter, treasury, protocolFeeBps],
    { kind: "uups", unsafeAllow: ["constructor"] }
  );
  await proxy.waitForDeployment();
  const addr = await proxy.getAddress();
  const impl = await upgrades.erc1967.getImplementationAddress(addr);

  console.log("\n✅ تم النشر:");
  console.log("  Proxy          :", addr);
  console.log("  Implementation :", impl);
  console.log("  nextDealId     :", (await proxy.nextDealId()).toString());
  console.log("\nⓘ على Mainnet: انقل الملكية لـ Safe، واضبط attestor لخدمة qist-btc، وأجرِ التدقيق أولاً.");
}

main().catch((e) => { console.error(e); process.exit(1); });
