/**
 * force_import_proxy — يسجّل الـ Proxy المنشور في manifest إضافة OZ upgrades.
 * ⚠️ شغّله فقط والمصدر المحلي = نفس الـ Implementation المنشور (Build 17 commit)
 *    لأن التسجيل يعتمد تخطيط التخزين من الـ artifacts المُجمَّعة حالياً.
 *   npx hardhat run scripts/force_import_proxy.ts --network base
 */
import { ethers, upgrades } from "hardhat";

const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";

async function main() {
  const Factory = await ethers.getContractFactory("MurabahaV6");
  await upgrades.forceImport(PROXY, Factory, { kind: "uups" });
  console.log("✅ سُجّل الـ Proxy في .openzeppelin/ بتخطيط المصدر الحالي (Build 17)");
}

main().catch((e) => { console.error(e); process.exit(1); });
