import hre, { ethers, upgrades } from "hardhat";
import {
  PROXY, EXPECTED_OWNER, ALLOWED_CHAINS, EIP170, UPG,
  proxyImpl, proxyInitVersion, linkBytecode, assertCodeMatches,
} from "./build22-upgrade";

/**
 * Build 23 (R-1 push-or-credit + R-2 مهلة بعد الاستئناف) — مشترك بين التجهيز والمحاكاة. لا يلمس الـProxy.
 *
 * - CustodyLib **جديدة** (تغيّر توقيعها: totalPendingToken). المكتبات الثلاث الأخرى **تُعاد** من Build 22
 *   بعد التحقق أن كودها الحي = المُجمَّع محلياً (لم تتغيّر منذ tag build22-deployed-src).
 * - بلا initializer: المتغيرات الثلاثة الجديدة (slots 29–31) تبدأ صفراً ⇒ upgradeToAndCall(impl, 0x).
 * - التخزين يُتحقق ضد **Build 22 الحي** عبر contracts/legacy/b22 (مطابقة الكود التنفيذي أولاً).
 */

export const BUILD22_IMPL = "0x962dd7ad2aaa80eff2ea303ae7e901a0a39c5de0";
export const BUILD22_CODEHASH = "0x0f2e85eea4043e8d98c00a7721af780bca5b47e9ea1a2e6174cfabb95751ff81";
export const BUILD22_LIBS = {
  CustodyLib: "0xF52113C7094f59e09f01aff2425Aaadc270F5244",
  BuyLogic: "0x2b307BdEBe421cb529c27736EC74143a7C1e9DDc",
  OfferLogic: "0x550b8Cf91D9338d578D426BACB4e9653553037A4",
  AutomationLogic: "0x9b459e5f6b1A5195f5Cc1f7e5B8C277D8Dc99AA3",
} as const;
export const REUSED = ["BuyLogic", "OfferLogic", "AutomationLogic"] as const;

const strip = (h: string) => h.toLowerCase().replace(/^0x/, "");
/** يحذف ذيل CBOR (البيانات الوصفية) — يختلف حتماً لأن النسخة المرجعية أُعيدت تسميتها */
const noMeta = (h: string) => h.slice(0, h.length - 4 - parseInt(h.slice(-4), 16) * 2);

/** شروط ما قبل أي نشر أو إخراج calldata: الشبكة · Build 22 الحي وبصمته · تهيئة 3 · المالك الـSafe */
export async function preflight23() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!ALLOWED_CHAINS.includes(chainId)) throw new Error(`⛔ شبكة غير مسموحة chainId=${chainId}`);
  const impl = await proxyImpl();
  if (impl !== BUILD22_IMPL) throw new Error(`⛔ تنفيذ الـProxy الحالي ${impl} ≠ Build 22 ${BUILD22_IMPL}`);
  const hash = ethers.keccak256(await ethers.provider.getCode(impl));
  if (hash !== BUILD22_CODEHASH) throw new Error(`⛔ بصمة كود التنفيذ الحالي ${hash} ≠ المسجّلة`);
  const ver = await proxyInitVersion();
  if (ver !== 3n) throw new Error(`⛔ نسخة التهيئة ${ver} ≠ 3`);
  const owner = await new ethers.Contract(PROXY, ["function owner() view returns (address)"], ethers.provider).owner();
  if (owner.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) throw new Error(`⛔ المالك ${owner} ≠ الـSafe المتوقع`);
  return { chainId, impl, hash, ver, owner };
}

/**
 * ينشر CustodyLib الجديدة ثم التنفيذ المربوط، ويتحقق من كود كلٍّ منها.
 * إعادة الاستخدام (للتحقق بعد نشر فعلي): LIB_CustodyLib=<عنوان> و IMPL_BUILD23=<عنوان> — يُقبلان فقط إن طابق كودهما.
 */
export async function deployBuild23(signer?: any) {
  const libs: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  for (const L of REUSED) {
    libs[L] = ethers.getAddress(BUILD22_LIBS[L]);
    sizes[L] = await assertCodeMatches(`${L} (Build 22، مُعاد)`, libs[L], strip((await hre.artifacts.readArtifact(L)).deployedBytecode));
  }
  if (process.env.LIB_CustodyLib) {
    libs.CustodyLib = ethers.getAddress(process.env.LIB_CustodyLib);
  } else {
    const c = await (await ethers.getContractFactory("CustodyLib", signer)).deploy();
    await c.waitForDeployment();
    libs.CustodyLib = await c.getAddress();
  }
  if (libs.CustodyLib.toLowerCase() === BUILD22_LIBS.CustodyLib.toLowerCase())
    throw new Error("⛔ CustodyLib لـBuild 23 يجب أن تكون جديدة — مكتبة Build 22 بتوقيع قديم");
  sizes.CustodyLib = await assertCodeMatches("CustodyLib (جديدة)", libs.CustodyLib, strip((await hre.artifacts.readArtifact("CustodyLib")).deployedBytecode));

  const Factory = await ethers.getContractFactory("MurabahaV6", { libraries: libs, signer });
  let implAddr: string;
  if (process.env.IMPL_BUILD23) {
    implAddr = ethers.getAddress(process.env.IMPL_BUILD23);
  } else {
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    implAddr = await impl.getAddress();
  }
  sizes.MurabahaV6 = await assertCodeMatches("MurabahaV6 (Build 23)", implAddr, linkBytecode(await hre.artifacts.readArtifact("MurabahaV6"), libs));
  for (const [k, v] of Object.entries(sizes)) if (v > EIP170) throw new Error(`⛔ ${k} ${v} > ${EIP170}`);
  return { libs, implAddr, sizes, Factory };
}

/**
 * توافق التخزين ضد **Build 22 الفعلي**: الكود التنفيذي الحي = contracts/legacy/b22 مربوطاً بمكتباته الحية،
 * ثم forceImport بمصنع Build 22 (لا بالمصنع الجديد — وإلا نجحت المقارنة دائماً) ثم validateUpgrade.
 */
export async function validateAgainstBuild22(Factory: any) {
  await preflight23();
  const libs22 = {
    CustodyLibB22: BUILD22_LIBS.CustodyLib, BuyLogic: BUILD22_LIBS.BuyLogic,
    OfferLogic: BUILD22_LIBS.OfferLogic, AutomationLogic: BUILD22_LIBS.AutomationLogic,
  };
  const art22 = await hre.artifacts.readArtifact("MurabahaV6Build22");
  const live = strip(await ethers.provider.getCode(BUILD22_IMPL)).split(strip(BUILD22_IMPL)).join("0".repeat(40));
  if (noMeta(live) !== noMeta(linkBytecode(art22, libs22)))
    throw new Error("⛔ contracts/legacy/b22 لا يطابق التنفيذ الحي (الكود التنفيذي)");
  const B22 = await ethers.getContractFactory("MurabahaV6Build22", { libraries: libs22 });
  await upgrades.forceImport(PROXY, B22, { kind: "uups", unsafeAllow: ["constructor"], unsafeAllowLinkedLibraries: true });
  await upgrades.validateUpgrade(PROXY, Factory, UPG);
}

/** معاملة الـSafe: ترقية بلا تهيئة */
export function upgradeCalldata23(implAddr: string) {
  return new ethers.Interface(["function upgradeToAndCall(address,bytes) payable"])
    .encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);
}
