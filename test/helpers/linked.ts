import { ethers, artifacts } from "hardhat";
import type { MurabahaV6__factory } from "../../typechain-types";

/**
 * Build 22: MurabahaV6 مربوط بأربع مكتبات خارجية (حدّ الحجم — docs/size-analysis.md).
 * كل اختبار ينشئ المصنع عبر هذه الدالة بدل getContractFactory("MurabahaV6") مباشرة.
 */
export const LINKED_LIBS = ["CustodyLib", "BuyLogic", "OfferLogic", "AutomationLogic"] as const;

export async function deployLibs() {
  const out: Record<string, string> = {};
  for (const L of LINKED_LIBS) {
    const lib = await (await ethers.getContractFactory(L)).deploy();
    out[L] = await lib.getAddress();
  }
  return out;
}

/** مصنع عقد يحتاج المكتبات الأربع (MurabahaV6 أو عقد اختبار يرثه) */
export async function linkedFactory(name?: "MurabahaV6", signer?: any): Promise<MurabahaV6__factory>;
export async function linkedFactory(name: string, signer?: any): Promise<any>;
export async function linkedFactory(name = "MurabahaV6", signer?: any): Promise<any> {
  return ethers.getContractFactory(name, { libraries: await deployLibs(), signer });
}

/** خيارات OpenZeppelin upgrades للمكتبات المربوطة (مطلوبة منذ CustodyLib) */
export const UPG = { unsafeAllow: ["constructor"] as any, unsafeAllowLinkedLibraries: true };

/**
 * أخطاء مخصّصة تُرمى من داخل المكتبات لا تظهر في ABI العقد (solc لا يضمّها). العميل —
 * التطبيق والموقع والاختبارات — يحتاج **ABI مدموجاً** لفكّها. هذه الدالة تعيد العقد نفسه
 * بواجهة = ABI العقد + أخطاء المكتبات الأربع (بلا تكرار).
 */
export async function withLibErrors<T extends { getAddress(): Promise<string>; interface: any; runner?: any }>(c: T) {
  const seen = new Set<string>();
  const frags: any[] = [];
  const add = (f: any) => { const k = f.type + ":" + f.format("full"); if (!seen.has(k)) { seen.add(k); frags.push(f); } };
  c.interface.fragments.forEach(add);
  for (const L of LINKED_LIBS) {
    const art = await artifacts.readArtifact(L);
    new ethers.Interface(art.abi).fragments.filter((f: any) => f.type === "error").forEach(add);
  }
  return new ethers.Contract(await c.getAddress(), frags, c.runner);
}
