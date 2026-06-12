import { ethers } from "hardhat";

const PROXY = "0x027C5f1aFBD9FCef650E135794E3AB865180bC8A";
const ABI = [
  "function brokerageFeeBps() view returns (uint16)",
  "function protocolFeeBps() view returns (uint16)",
  "function brokerTreasury() view returns (address)",
  "function protocolTreasury() view returns (address)",
  "function owner() view returns (address)",
  "function pendingETH(address) view returns (uint256)",
  "event BrokerageCollected(uint256 indexed offerId, address saleToken, uint256 sellerFee, uint256 buyerFee, uint256 protocolFee, address brokerTreasury, address protocolTreasury)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const c = new ethers.Contract(PROXY, ABI, provider);

  const [brokBps, protBps, brokerAddr, protAddr, owner] = await Promise.all([
    c.brokerageFeeBps(), c.protocolFeeBps(),
    c.brokerTreasury(), c.protocolTreasury(), c.owner()
  ]);

  const [pendingBroker, pendingProt] = await Promise.all([
    c.pendingETH(brokerAddr), c.pendingETH(protAddr)
  ]);

  console.log("═══ إعدادات الرسوم الحالية ═══");
  console.log(`  رسوم الوساطة (Brokerage): ${Number(brokBps)/100}% لكل طرف (بائع + مشتري)`);
  console.log(`  رسوم البروتوكول:           ${Number(protBps)/100}%`);
  console.log(`  إجمالي الرسوم على الصفقة:  ${(Number(brokBps)*2 + Number(protBps))/100}%`);
  console.log();
  console.log("═══ عناوين الخزينة ═══");
  console.log(`  brokerTreasury:   ${brokerAddr}`);
  console.log(`  protocolTreasury: ${protAddr}`);
  console.log(`  owner:            ${owner}`);
  console.log(`  نفس العنوان؟     ${brokerAddr.toLowerCase() === protAddr.toLowerCase() ? "نعم (افتراضي)" : "لا (منفصلان)"}`);
  console.log();
  console.log("═══ ETH مستحق (Pending) ═══");
  console.log(`  brokerTreasury:   ${ethers.formatEther(pendingBroker)} ETH`);
  console.log(`  protocolTreasury: ${ethers.formatEther(pendingProt)} ETH`);

  // آخر 5 أحداث BrokerageCollected
  console.log("\n═══ آخر أحداث BrokerageCollected ═══");
  try {
    const latest = await provider.getBlockNumber();
    const from   = Math.max(0, latest - 50000);
    const rC = new ethers.Contract(PROXY, ABI, provider);
    const events = await rC.queryFilter(rC.filters.BrokerageCollected(), from);
    if (events.length === 0) { console.log("  لا أحداث بعد"); }
    for (const e of events.slice(-5)) {
      const a = (e as any).args;
      const total = Number(a.sellerFee) + Number(a.buyerFee) + Number(a.protocolFee);
      console.log(`  عرض #${a.offerId}: sellerFee=${ethers.formatEther(a.sellerFee)} ETH  buyerFee=${ethers.formatEther(a.buyerFee)} ETH  protocol=${ethers.formatEther(a.protocolFee)} ETH  مجموع=${ethers.formatEther(BigInt(total))} ETH`);
      console.log(`    → brokerTreasury:   ${a.brokerTreasury}`);
      console.log(`    → protocolTreasury: ${a.protocolTreasury}`);
    }
  } catch(e: any) { console.log("  خطأ:", e.message); }
}
main().catch(console.error);
