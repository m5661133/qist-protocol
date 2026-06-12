import { ethers } from "hardhat";

const PROXY  = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const BROKER = "0xbF435581067E4FcB9e1001619087F4e9a846d8be";

const ABI = [
  "function withdrawETH() external",
  "function pendingETH(address) view returns (uint256)",
];

async function main() {
  // نستخدم المفتاح الخاص للـ Broker من .env
  const provider = ethers.provider;
  const privKey = process.env.BROKER_PRIVATE_KEY;
  
  if (!privKey) {
    console.log("❌ أضف BROKER_PRIVATE_KEY في ملف .env");
    console.log("   BROKER_PRIVATE_KEY=0x...");
    return;
  }

  const signer = new ethers.Wallet(privKey, provider);
  console.log(`\nالسحب من: ${signer.address}`);

  const pool = new ethers.Contract(PROXY, ABI, signer);
  
  const pending = await pool.pendingETH(signer.address);
  console.log(`ETH مستحق: ${ethers.formatEther(pending)} ETH`);
  
  if (pending === 0n) {
    console.log("لا يوجد شيء للسحب");
    return;
  }

  const tx = await pool.withdrawETH();
  console.log(`TX: ${tx.hash}`);
  await tx.wait();
  
  const bal = await provider.getBalance(signer.address);
  console.log(`✅ تم! الرصيد الجديد: ${ethers.formatEther(bal)} ETH`);
}

main().catch(console.error);
