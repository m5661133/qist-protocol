import hre, { ethers, upgrades } from "hardhat";

/**
 * Build 22 — نشر المكتبات الأربع + implementation مربوط، والتحقق من كود كل منها.
 * مشترك بين scripts/prepare-upgrade-build22-safe.ts (الشبكة) وscripts/fork-upgrade-build22.ts (المحاكاة).
 * لا يلمس الـProxy.
 */

export const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
export const BUILD21_IMPL = "0x0c0114d6a15bba02a7ef89894462d52ee5f283a7";
export const BUILD21_CODEHASH = "0x7d0dd0aa386fc98950e36933897b355a61038b9ab133c9434e42df775bef6f3b";
export const LIBS = ["CustodyLib", "BuyLogic", "OfferLogic", "AutomationLogic"] as const;
export const EIP170 = 24_576;
export const EXPECTED_OWNER = "0x64D738021BAe4cb9a7fd82529C2F94f61d404064"; // Safe 2-of-3
export const ALLOWED_CHAINS = [8453n, 31337n]; // Base · نسخة hardhat المتفرّعة منها
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const INIT_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00"; // OZ v5 Initializable

/** قرار المالك 2026-10-02: 20,000 إجمالي · 15,000 التزامات · 5,000 عروض غير مباعة */
export const CAPS = { global: 20_000n * 10n ** 6n, commitment: 15_000n * 10n ** 6n, offer: 5_000n * 10n ** 6n };

export const UPG = { kind: "uups" as const, unsafeAllow: ["constructor" as const], unsafeAllowLinkedLibraries: true };

const strip = (h: string) => h.toLowerCase().replace(/^0x/, "");

export const proxyImpl = async () => "0x" + (await ethers.provider.getStorage(PROXY, IMPL_SLOT)).slice(-40);
export const proxyInitVersion = async () =>
  BigInt(await ethers.provider.getStorage(PROXY, INIT_SLOT)) & ((1n << 64n) - 1n);

/**
 * B6-UPG-01: شروط ما قبل أي نشر أو forceImport أو إخراج calldata — مشتركة بين التجهيز والمحاكاة.
 * يرفض أي اختلاف: الشبكة، تنفيذ الـProxy الحالي وبصمته، نسخة التهيئة، المالك.
 */
export async function preflight() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!ALLOWED_CHAINS.includes(chainId)) throw new Error(`⛔ شبكة غير مسموحة chainId=${chainId}`);
  const impl = await proxyImpl();
  if (impl !== BUILD21_IMPL) throw new Error(`⛔ تنفيذ الـProxy الحالي ${impl} ≠ Build 21 ${BUILD21_IMPL}`);
  const hash = ethers.keccak256(await ethers.provider.getCode(impl));
  if (hash !== BUILD21_CODEHASH) throw new Error(`⛔ بصمة كود التنفيذ الحالي ${hash} ≠ المسجّلة`);
  const ver = await proxyInitVersion();
  if (ver !== 1n) throw new Error(`⛔ نسخة التهيئة ${ver} ≠ 1`);
  const owner = await new ethers.Contract(PROXY, ["function owner() view returns (address)"], ethers.provider).owner();
  if (owner.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) throw new Error(`⛔ المالك ${owner} ≠ الـSafe المتوقع`);
  return { chainId, impl, hash, ver, owner };
}

/** artifact مربوط: يستبدل placeholders المكتبات بعناوينها */
export function linkBytecode(art: any, libs: Record<string, string>) {
  let code = strip(art.deployedBytecode);
  for (const file of Object.keys(art.deployedLinkReferences ?? {}))
    for (const name of Object.keys(art.deployedLinkReferences[file]))
      for (const { start, length } of art.deployedLinkReferences[file][name])
        code = code.slice(0, start * 2) + strip(libs[name]).padStart(length * 2, "0") + code.slice((start + length) * 2);
  return code;
}

/** يقارن كوداً منشوراً بالـartifact بعد تصفير عنوان العقد نفسه (UUPS __self / حماية استدعاء المكتبة) */
export async function assertCodeMatches(label: string, addr: string, expected: string) {
  // RPC العام قد يعيد كوداً فارغاً لحظة بعد النشر (عُقد متعددة خلفه) — ننتظر ظهوره قبل المقارنة
  let onchain = strip(await ethers.provider.getCode(addr));
  for (let i = 0; i < 20 && onchain.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    onchain = strip(await ethers.provider.getCode(addr));
  }
  const zeroed = onchain.split(strip(addr)).join("0".repeat(40));
  if (zeroed !== expected) throw new Error(`⛔ ${label}: الكود المنشور لا يطابق المُجمَّع محلياً`);
  return onchain.length / 2;
}

export async function deployBuild22(signer?: any) {
  const libs: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  for (const L of LIBS) {
    // LIB_<اسم>=<عنوان>: إعادة استخدام مكتبة منشورة سابقاً — تُقبل فقط إن طابق كودها المُجمَّع (أدناه)
    const reuse = process.env[`LIB_${L}`];
    if (reuse) {
      libs[L] = ethers.getAddress(reuse);
    } else {
      const c = await (await ethers.getContractFactory(L, signer)).deploy();
      await c.waitForDeployment();
      libs[L] = await c.getAddress();
    }
    const art = await hre.artifacts.readArtifact(L);
    sizes[L] = await assertCodeMatches(L, libs[L], strip(art.deployedBytecode));
  }
  const Factory = await ethers.getContractFactory("MurabahaV6", { libraries: libs, signer });
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  const art = await hre.artifacts.readArtifact("MurabahaV6");
  sizes.MurabahaV6 = await assertCodeMatches("MurabahaV6", implAddr, linkBytecode(art, libs));
  for (const [k, v] of Object.entries(sizes)) if (v > EIP170) throw new Error(`⛔ ${k} ${v} > ${EIP170}`);
  return { libs, implAddr, sizes, Factory };
}

/** تحقق من نشر سابق: كود المكتبات والتنفيذ المربوط على السلسلة = المُجمَّع محلياً */
export async function verifyDeployed(libs: Record<string, string>, implAddr: string) {
  const sizes: Record<string, number> = {};
  for (const L of LIBS) sizes[L] = await assertCodeMatches(L, libs[L], strip((await hre.artifacts.readArtifact(L)).deployedBytecode));
  sizes.MurabahaV6 = await assertCodeMatches("MurabahaV6", implAddr, linkBytecode(await hre.artifacts.readArtifact("MurabahaV6"), libs));
  return sizes;
}

/**
 * توافق التخزين ضد **Build 21 الفعلي**: forceImport بمصنع Build 21 (لا بالمصنع الجديد —
 * وإلا سجّل OZ تخطيط النسخة الجديدة كأنه الحالي فتنجح المقارنة دائماً)، ثم validateUpgrade.
 */
export async function validateAgainstBuild21(Factory: any) {
  await preflight(); // B6-UPG-01: لا forceImport لتخطيط Build 21 ما لم يكن الـProxy عليه فعلاً
  const B21 = await ethers.getContractFactory("MurabahaV6Build21");
  const art21 = await hre.artifacts.readArtifact("MurabahaV6Build21");
  const live = strip(await ethers.provider.getCode(BUILD21_IMPL));
  const zeroed = live.split(strip(BUILD21_IMPL)).join("0".repeat(40));
  // الذيل (CBOR metadata) يختلف حتماً: العقد أُعيدت تسميته MurabahaV6Build21 فتغيّر hash البيانات الوصفية.
  // الكود التنفيذي نفسه يجب أن يطابق حرفياً.
  const noMeta = (h: string) => h.slice(0, h.length - 4 - parseInt(h.slice(-4), 16) * 2);
  if (noMeta(zeroed) !== noMeta(strip(art21.deployedBytecode)))
    throw new Error("⛔ مصدر legacy/b21 لا يطابق التنفيذ الحي (الكود التنفيذي)");
  await upgrades.forceImport(PROXY, B21, { kind: "uups" });
  await upgrades.validateUpgrade(PROXY, Factory, UPG);
}

/** يتطلّب preflight() ناجحاً قبل الاستدعاء على الشبكة (prepare يعيده قبل الإخراج مباشرة) */
export function upgradeCalldata(implAddr: string, caps = CAPS) {
  const init = new ethers.Interface(["function initializeV3(uint256,uint256,uint256)"])
    .encodeFunctionData("initializeV3", [caps.global, caps.commitment, caps.offer]);
  return new ethers.Interface(["function upgradeToAndCall(address,bytes) payable"])
    .encodeFunctionData("upgradeToAndCall", [implAddr, init]);
}
