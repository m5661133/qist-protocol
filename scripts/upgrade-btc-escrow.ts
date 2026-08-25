import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * ترقية BtcEscrowMurabaha على Base Mainnet، مع تسجيل نقطة رجوع.
 *
 *   npx hardhat run scripts/upgrade-btc-escrow.ts --network base
 *   LABEL="وصف الترقية" npx hardhat run scripts/upgrade-btc-escrow.ts --network base
 *
 * السلامة:
 *  1. `validateUpgrade` من OpenZeppelin يفحص توافق التخزين فعلياً — لا نستبدله
 *     ببوابة يدوية. إن رفض، توقّف: الترقية ستُفسد بيانات الصفقات.
 *  2. يُسجَّل الـimplementation الحالي في deployments/btc-escrow.json **قبل**
 *     الترقية، فيبقى الرجوع ممكناً بـscripts/rollback-btc-escrow.ts.
 *  3. تجاوز فحص التخزين متاح بـUNSAFE_SKIP_STORAGE=1 — لإعادة هيكلة struct
 *     مقصودة على عقد بلا بيانات فقط. يُسجَّل في السجل كقيد غير آمن للرجوع.
 */

const REG = path.join(__dirname, "..", "deployments", "btc-escrow.json");

async function main() {
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  const PROXY = reg.proxy as string;
  const skipStorage = process.env.UNSAFE_SKIP_STORAGE === "1";

  const [signer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("BtcEscrowMurabaha");
  const current: any = Factory.attach(PROXY);

  const owner = await current.owner();
  console.log("الموقّع:", signer.address);
  console.log("المالك :", owner);
  if (owner.toLowerCase() !== signer.address.toLowerCase())
    throw new Error(`الموقّع ليس المالك — الترقية ستفشل`);

  const before = await upgrades.erc1967.getImplementationAddress(PROXY);
  const deals = await current.nextDealId();
  console.log("Implementation الحالي:", before);
  console.log("عدد الصفقات المكتوبة :", (deals - 1n).toString());

  const opts = { kind: "uups" as const, unsafeAllow: ["constructor" as const] };

  if (skipStorage) {
    console.warn("\n⚠️ تجاوز فحص التخزين مفعّل — لا تستخدمه إلا لإعادة هيكلة مقصودة");
    if (deals > 1n)
      throw new Error(`⛔ توجد ${deals - 1n} صفقة مكتوبة — تجاوز الفحص سيُفسدها`);
  } else {
    console.log("\n⏳ فحص توافق التخزين ...");
    await upgrades.validateUpgrade(PROXY, Factory, opts);
    console.log("✅ التخزين متوافق — الرجوع لهذه النقطة سيبقى آمناً");
  }

  console.log("⏳ نشر implementation جديد وترقية الـproxy ...");
  await (await upgrades.upgradeProxy(PROXY, Factory, {
    ...opts,
    ...(skipStorage ? { unsafeSkipStorageCheck: true } : {}),
  })).waitForDeployment();

  // القراءة مباشرة بعد المعاملة قد تضرب عقدة متأخّرة — نتحقّق من التغيّر فعلاً
  let after = before;
  for (let i = 0; i < 10 && after.toLowerCase() === before.toLowerCase(); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await upgrades.erc1967.getImplementationAddress(PROXY);
  }
  if (after.toLowerCase() === before.toLowerCase())
    throw new Error("⛔ الـimplementation لم يتغيّر — تحقّق يدوياً قبل أي استنتاج");

  console.log("✅ تمّت الترقية");
  console.log("   السابق (نقطة رجوع):", before);
  console.log("   الجديد            :", after);

  reg.history.push({
    implementation: after,
    date: new Date().toISOString().slice(0, 10),
    label: process.env.LABEL || "بلا وصف",
    storageChange: skipStorage ? "إعادة هيكلة (تجاوز الفحص)" : "لا تغيير في التخزين",
    rollbackSafe: !skipStorage,
    why: skipStorage
      ? "أُعيد هيكلة التخزين — الرجوع لما قبله يُفسد قراءة الصفقات"
      : "تغيير منطق/ثوابت فقط — الرجوع آمن",
  });
  fs.writeFileSync(REG, JSON.stringify(reg, null, 2) + "\n");
  console.log("📝 سُجّل في deployments/btc-escrow.json");
  console.log(`\nالتوثيق: npx hardhat verify --network base ${after}`);
  console.log(`الرجوع : IMPL=${before} npx hardhat run scripts/rollback-btc-escrow.ts --network base`);
}

main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
