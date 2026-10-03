import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { deployScenario, runScenario, OPS } from "./helpers/custodyScenario";

/**
 * مقارنة سلوكية: نسخة السقف **قبل** إعادة الهيكلة (MurabahaV6Baseline = نسخة العمل غير المحفوظة)
 * مقابل **بعدها** (C1 + BuyLogic/OfferLogic/AutomationLogic/PricingLib). نفس السيناريو والبذرة.
 * تُقارَن: نتيجة كل مسار، وتسلسل أحداث العقد كاملاً (topics + data)، وكل العروض والمراكز،
 * وأرصدة الرموز للأطراف، وETH المعلّق. لا تُقارَن أرصدة ETH للمرسلين (تختلف بالغاز فقط).
 */
async function baselineFactory() {
  const lib = await (await ethers.getContractFactory("CustodyLib")).deploy();
  return ethers.getContractFactory("MurabahaV6Baseline", { libraries: { CustodyLib: await lib.getAddress() } });
}

/** عناوين النشر (رموز ومغذّيات وتنفيذ ووكيل) تختلف بين التشغيلتين — تُستبدل بأسماء ثابتة */
async function normalizer(s: any) {
  const map: [string, string][] = [];
  const add = async (name: string, addr: string) => map.push([addr.toLowerCase().slice(2), name]);
  await add("<USDC>", await s.usdc.getAddress()); await add("<WBTC>", s.wAddr);
  await add("<ETHFEED>", await s.ethFeed.getAddress()); await add("<BTCFEED>", await s.btcFeed.getAddress());
  await add("<PROXY>", s.mAddr);
  const implAddr = await upgrades.erc1967.getImplementationAddress(s.mAddr);
  await add("<IMPL>", implAddr);
  return (h: string) => { let x = h.toLowerCase(); for (const [a, n] of map) x = x.split(a).join(n); return x; };
}

async function snapshot(s: any) {
  const norm = await normalizer(s);
  const logs = await ethers.provider.getLogs({ address: s.mAddr, fromBlock: s.fromBlock ?? 0, toBlock: "latest" });
  const events = logs.map((l) => ({ topics: l.topics.map(norm), data: norm(l.data) }));
  const offers = [], positions = [];
  for (let i = 1n; i < (await s.m.nextOfferId()); i++) offers.push((await s.m.getOffer(i)).toArray().map((v: any) => norm(String(v))));
  for (let i = 1n; i < (await s.m.nextPositionId()); i++) {
    const p = (await s.m.getPosition(i)).toArray().map((v: any) => norm(String(v)));
    p[11] = "nextDueDate"; // يعتمد على طابع الكتلة — يختلف بين التشغيلتين
    positions.push(p);
  }
  const actors = [...s.sellers, ...s.buyers, s.owner, s.stranger];
  const tokens = [];
  for (const a of actors) tokens.push([String(await s.wbtc.balanceOf(a.address)), String(await s.usdc.balanceOf(a.address)), String(await s.m.pendingETH(a.address))]);
  return {
    events, offers, positions, tokens,
    contractETH: String(await ethers.provider.getBalance(s.mAddr)),
    contractWBTC: String(await s.wbtc.balanceOf(s.mAddr)),
    totalPendingETH: String(await s.m.totalPendingETH()),
    exposure: String(await s.m.totalExposureUSDC()),
  };
}

// يعمل فقط بإعدادات المقارنة: DIFF_UNLIMITED=1 npx hardhat --config hardhat.diff.config.ts test test/BuildDiff.behavior.test.ts
(process.env.DIFF_UNLIMITED ? describe : describe.skip)("مقارنة سلوكية: قبل إعادة الهيكلة ⇄ بعدها", () => {
  for (const seed of [20261001, 7, 424242]) {
    it(`البذرة ${seed}: نفس النتائج والأحداث والحالة والأرصدة`, async () => {
      const before = await deployScenario(baselineFactory);
      const okB = await runScenario(before, seed, 150);
      const snapB = await snapshot(before);

      const after = await deployScenario();
      const okA = await runScenario(after, seed, 150);
      const snapA = await snapshot(after);

      expect(okA).to.deep.equal(okB);
      for (const op of OPS) expect(okA[op], op).to.be.greaterThan(0);
      expect(snapA.events.length).to.equal(snapB.events.length);
      expect(snapA.events).to.deep.equal(snapB.events);
      expect(snapA.offers).to.deep.equal(snapB.offers);
      expect(snapA.positions).to.deep.equal(snapB.positions);
      expect(snapA.tokens).to.deep.equal(snapB.tokens);
      for (const k of ["contractETH", "contractWBTC", "totalPendingETH", "exposure"] as const)
        expect(snapA[k], k).to.equal(snapB[k]);
      console.log(`      ${snapA.events.length} حدثاً متطابقاً · ${snapA.offers.length} عرضاً · ${snapA.positions.length} مركزاً`);
    });
  }

  it("أخطاء المسارات المنقولة: نفس selector ونفس الوسائط", async () => {
    const before = await deployScenario(baselineFactory);
    const after = await deployScenario();
    const usdc = await before.usdc.getAddress(), usdc2 = await after.usdc.getAddress();
    const cases = async (s: any, u: string) => {
      const out: string[] = [];
      const tryCall = async (f: () => Promise<any>) => {
        try { await f(); out.push("ok"); } catch (e: any) { out.push(e?.data ?? e?.info?.error?.data ?? String(e?.message).slice(0, 80)); }
      };
      await s.m.connect(s.seller).createOffer(s.wAddr, s.wAddr, u, 10_000_000n, 1000, 2, 12, 60, 1_000_000n, 12000, false);
      const B = (amt: bigint, col: bigint, q: bigint, n: number) => s.m.connect(s.buyer).buy.staticCall(1, amt, col, q, n, false);
      await tryCall(() => B(0n, 1n, 60000n * 10n ** 6n, 12));                  // InvalidParams
      await tryCall(() => B(500_000n, 1n, 60000n * 10n ** 6n, 12));            // BelowMinPurchase
      await tryCall(() => B(5_000_000n, 1n, 60000n * 10n ** 6n, 13));          // InvalidInstallments
      await tryCall(() => B(5_000_000n, 1n, 50000n * 10n ** 6n, 12));          // SlippageExceeded
      await tryCall(() => B(5_000_000n, 1n, 60000n * 10n ** 6n, 12));          // InsufficientCollateral
      await tryCall(() => s.m.connect(s.seller).buy.staticCall(1, 5_000_000n, 9_000_000n, 60000n * 10n ** 6n, 12, false)); // SelfBuy
      await tryCall(() => s.m.connect(s.seller).createOffer.staticCall(s.wAddr, s.wAddr, u, 1n, 30001, 1, 12, 60, 0, 12000, false)); // InvalidParams (profit)
      await tryCall(() => s.m.connect(s.seller).createOffer.staticCall(s.wAddr, s.wAddr, u, 1n, 1000, 1, 12, 59, 0, 12000, false));  // InvalidParams (interval)
      await tryCall(() => s.m.estimatePurchase(1, 5_000_000n, 13));            // InvalidInstallments
      out.push(String((await s.m.estimatePurchase(1, 5_000_000n, 12)).toArray()));
      return out;
    };
    const a = await cases(after, usdc2), b = await cases(before, usdc);
    expect(a).to.deep.equal(b);
    for (const x of a.slice(0, 9)) expect(x).to.match(/^0x[0-9a-f]{8}/);   // كلها أخطاء مخصّصة مُرمّزة
  });

  it("الغاز: كلفة الاستدعاءات المنقولة (للتقرير)", async () => {
    const out: Record<string, bigint[]> = {};
    for (const [name, fac] of [["قبل", baselineFactory], ["بعد", undefined]] as const) {
      const s = await deployScenario(fac as any);
      const u = await s.usdc.getAddress();
      const r1 = await (await s.m.connect(s.seller).createOffer(s.wAddr, s.wAddr, u, 10_000_000n, 1000, 1, 12, 60, 0, 12000, false)).wait();
      const r2 = await (await s.m.connect(s.buyer).buy(1, 5_000_000n, 9_000_000n, 60000n * 10n ** 6n, 12, false)).wait();
      const g3 = await s.m.checkUpkeep.estimateGas("0x");
      const g4 = await s.m.estimatePurchase.estimateGas(1, 1_000_000n, 12);
      out[name] = [r1!.gasUsed, r2!.gasUsed, g3, g4];
    }
    console.log("      الغاز [createOffer, buy, checkUpkeep, estimatePurchase]");
    console.log("        قبل:", out["قبل"].map(String).join(" · "));
    console.log("        بعد:", out["بعد"].map(String).join(" · "));
  });
});
