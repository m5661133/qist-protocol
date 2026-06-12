import { ethers } from "ethers";
const PROXY = "0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5";
const RPC = "https://base-rpc.publicnode.com";
const ABI = [
  "function GRACE_PERIOD() view returns (uint256)",
  "function liquidatePositionPublic(uint256) external",
  "function processInstallmentPublic(uint256) external",
];
async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(PROXY, ABI, p);
  const grace = await c.GRACE_PERIOD();
  console.log(`GRACE_PERIOD على Base: ${grace}s`);
  console.log(`  = ${Number(grace)/60} دقيقة`);
  console.log(`  = ${Number(grace)/3600} ساعة`);
  console.log(`  = ${Number(grace)/86400} يوم`);

  // تحقق من الدوال الجديدة عبر selector
  const sig1 = ethers.id("liquidatePositionPublic(uint256)").slice(0,10);
  const sig2 = ethers.id("processInstallmentPublic(uint256)").slice(0,10);
  console.log(`\nliquidatePositionPublic selector: ${sig1}`);
  console.log(`processInstallmentPublic selector: ${sig2}`);

  // اختبر إن الدوال موجودة (سترفض لكن لا 0x)
  try {
    await c.liquidatePositionPublic.staticCall(999);
    console.log("⚠️ liquidatePositionPublic لم ترفض على مركز غير موجود");
  } catch (e: any) {
    console.log(`✅ liquidatePositionPublic موجودة (رفضت بـ: ${e.shortMessage || e.message.slice(0,80)})`);
  }
}
main().catch(console.error);
