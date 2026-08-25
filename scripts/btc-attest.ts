import { ethers } from "hardhat";

/**
 * أداة شهادات يدوية لمسار البيتكوين الحقيقي (BtcEscrowMurabaha v2) على Base.
 *
 * تُستدعى من محفظة الـattestor بعد كل حركة بيتكوين **حقيقية** على L1.
 * العقد لا يحرّك ساتوشي — هذه شهادات تسجيل فقط، والحركة تمّت على شبكة Bitcoin.
 *
 *   ACTION=status  ID=1                             npx hardhat run scripts/btc-attest.ts --network base
 *   ACTION=collateral ID=1 SATS=20000 TXID=<btc>    npx hardhat run scripts/btc-attest.ts --network base
 *   ACTION=delivery   ID=1 SATS=10000 TXID=<btc>    npx hardhat run scripts/btc-attest.ts --network base
 *   ACTION=released   ID=1 TXID=<btc>               npx hardhat run scripts/btc-attest.ts --network base
 *
 * ⚠️ لا تشهد بشيء لم يحدث فعلاً على شبكة Bitcoin ويُرى في mempool.space.
 */

const PROXY = "0x47Ce614E8D1EBd19d66f254c062bDDEA2F3e3103";
const VAULT = "bc1qh2pz6t8crs7ykxh66emp2huxm5futgdsget5wd5jsuhnnug42nks2q3vsn";

const STATES = ["OPEN","AWAITING_COLLATERAL","AWAITING_DELIVERY","ACTIVE",
  "PAYMENT_OVERDUE","MARGIN_CALL","DEFAULT_PENDING","DISPUTED",
  "LIQUIDATION_ELIGIBLE","LIQUIDATED","REPAID","COLLATERAL_RELEASED","CANCELLED"];

const btc = (s: bigint | number) => (Number(s) / 1e8).toFixed(8);
const usd = (v: bigint) => "$" + (Number(v) / 1e6).toFixed(2);

/// txid البيتكوين (64 hex) → bytes32
function toB32(txid: string): string {
  const clean = txid.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`txid غير صالح (يجب 64 حرفاً hex): ${txid}`);
  }
  return "0x" + clean;
}

async function show(m: any, id: bigint) {
  const d = await m.getDeal(id);
  console.log(`\n──── الصفقة #${id} ────`);
  console.log("  الحالة        :", STATES[Number(d.state)]);
  console.log("  البائع        :", d.seller);
  console.log("  المشتري       :", d.buyer);
  console.log("  الثمن المؤجّل  :", usd(d.totalPayable), `(تكلفة ${usd(d.cost)} + ${Number(d.profitBps)/100}%)`);
  console.log("  الأقساط       :", `${d.paidInstallments}/${d.totalInstallments}`);
  console.log("  المبيع        :", btc(d.merchandiseSats), "BTC");
  console.log("  الرهن المطلوب :", btc(d.requiredCollateralSats), "BTC");
  console.log("  الرهن المودَع  :", btc(d.collateralSats), "BTC");
  if (d.buyerBtcAddress) console.log("  عنوان المشتري :", d.buyerBtcAddress);
  if (Number(d.state) >= 3 && Number(d.state) <= 8) {
    try {
      const [ltv] = await m.previewHealth(id);
      console.log("  LTV           :", Number(ltv) / 100 + "%");
    } catch {}
  }
  console.log("");
}

async function main() {
  const action = (process.env.ACTION || "status").toLowerCase();
  const id = BigInt(process.env.ID || "0");
  if (id === 0n) throw new Error("حدّد ID=<رقم الصفقة>");

  const [signer] = await ethers.getSigners();
  const m: any = (await ethers.getContractFactory("BtcEscrowMurabaha")).attach(PROXY);

  if (action !== "status") {
    const attestor = await m.attestor();
    if (attestor.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`الموقّع ${signer.address} ليس الـattestor (${attestor})`);
    }
  }

  if (action === "status") { await show(m, id); return; }

  const txid = toB32(process.env.TXID || "");

  if (action === "collateral") {
    const sats = BigInt(process.env.SATS || "0");
    if (sats === 0n) throw new Error("حدّد SATS=<الساتوشي المُودَع>");
    const descHash = ethers.id(VAULT); // التزام بوصف الخزنة
    console.log(`⏳ شهادة إيداع الرهن: ${btc(sats)} BTC · txid ${txid.slice(0,18)}…`);
    const tx = await m.confirmCollateral(id, sats, descHash, txid);
    console.log("   tx:", tx.hash); await tx.wait();
  } else if (action === "delivery") {
    const sats = BigInt(process.env.SATS || "0");
    if (sats === 0n) throw new Error("حدّد SATS=<الساتوشي المُسلَّم>");
    console.log(`⏳ شهادة تسليم المبيع: ${btc(sats)} BTC · txid ${txid.slice(0,18)}…`);
    const tx = await m.confirmDelivery(id, sats, txid);
    console.log("   tx:", tx.hash); await tx.wait();
  } else if (action === "released") {
    console.log(`⏳ شهادة فكّ الرهن · txid ${txid.slice(0,18)}…`);
    const tx = await m.confirmCollateralReleased(id, txid);
    console.log("   tx:", tx.hash); await tx.wait();
  } else {
    throw new Error(`ACTION غير معروف: ${action} (status|collateral|delivery|released)`);
  }

  console.log("✅ سُجّلت الشهادة");
  await show(m, id);
}

main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
