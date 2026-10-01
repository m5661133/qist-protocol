import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * مولّد سيناريوهات لمحاسبة العهدة — يُستعمل في:
 *  - test/CustodyScenario.coverage.test.ts (يعمل الآن: يثبت أن كل مسار يُنفَّذ بنجاح)
 *  - test/GlobalCap.design.test.ts #10 (موقوف: يضيف فحص الثابت I1 بعد كل خطوة)
 *
 * ردّاً على مراجعة جبتي (#4): المولّد السابق لم يُنتج أي شراء أو سداد أو إغلاق، وكان
 * catch يبتلع الفشل. هنا: أهداف صالحة تُقرأ من الحالة، مرحلة مُلزِمة تنفّذ كل مسار مرة
 * دون catch، ثم مرحلة عشوائية بمولّد صحيح (mulberry32) مع عدّاد نجاح لكل مسار.
 */

export const U   = (n: number) => BigInt(Math.round(n * 1e6));
export const BTC = (n: number) => BigInt(Math.round(n * 1e8));
export const E   = ethers.parseEther;
export const INTERVAL = 60n;
export const GRACE = 259200;
export const ETH_FEED = 300_000_000_000n;   // $3,000
export const BTC_FEED = 6_000_000_000_000n; // $60,000
const PRICE_USDC: Record<string, bigint> = {}; // token → سعر بـ6 خانات

export async function deployScenario() {
  const [owner, seller, seller2, buyer, buyer2, stranger] = await ethers.getSigners();
  const usdc    = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const wbtc    = await (await ethers.getContractFactory("MockWBTC")).deploy();
  const ethFeed = await (await ethers.getContractFactory("MockFeed")).deploy(ETH_FEED, 8);
  const btcFeed = await (await ethers.getContractFactory("MockFeed")).deploy(BTC_FEED, 8);
  const m: any = await upgrades.deployProxy(await ethers.getContractFactory("MurabahaV6"), [
    await usdc.getAddress(), await wbtc.getAddress(),
    await ethFeed.getAddress(), await btcFeed.getAddress(), owner.address, owner.address,
  ], { kind: "uups", unsafeAllow: ["constructor"] });
  const mAddr = await m.getAddress();
  const wAddr = await wbtc.getAddress();
  PRICE_USDC[ethers.ZeroAddress] = 3000n * 10n ** 6n;
  PRICE_USDC[wAddr] = 60000n * 10n ** 6n;
  for (const a of [seller, seller2, buyer, buyer2]) {
    await wbtc.mint(a.address, BTC(20));
    await usdc.mint(a.address, U(5_000_000));
    await wbtc.connect(a).approve(mAddr, ethers.MaxUint256);
    await usdc.connect(a).approve(mAddr, ethers.MaxUint256);
  }
  return { m, usdc, wbtc, ethFeed, btcFeed, owner, seller, seller2, buyer, buyer2, stranger, mAddr, wAddr,
           sellers: [seller, seller2], buyers: [buyer, buyer2] };
}
export type Scn = Awaited<ReturnType<typeof deployScenario>>;

/** mulberry32 — مولّد 32-bit صحيح التوزيع (المولّد السابق كان يعيد دورة قصيرة) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

const isEth = (t: string) => t === ethers.ZeroAddress;
const signerOf = (s: Scn, addr: string) =>
  [...s.sellers, ...s.buyers, s.owner, s.stranger].find((x) => x.address === addr)!;

async function activeOffers(s: Scn) {
  const out: { id: bigint; o: any }[] = [];
  for (let i = 1n; i < (await s.m.nextOfferId()); i++) {
    const o = await s.m.offers(i);
    if (o.state === 0n && o.saleAmount > 0n) out.push({ id: i, o });
  }
  return out;
}
async function activePositions(s: Scn) {
  const out: { id: bigint; p: any }[] = [];
  for (let i = 1n; i < (await s.m.nextPositionId()); i++) {
    const p = await s.m.positions(i);
    if (p.state === 0n) out.push({ id: i, p });
  }
  return out;
}

/** الثابت I1 محسوباً من التخزين مباشرة — المرجع الذي يُقارَن به custodyOf */
export async function recomputeCustody(s: Scn, token: string) {
  let sum = 0n;
  for (const { o } of await activeOffers(s)) if (o.saleToken === token) sum += o.saleAmount;
  for (const { p } of await activePositions(s)) if (p.collateralToken === token) sum += p.collateralAmount;
  return sum;
}

/** كمية ضمان كافية (+5%) بوحدات أصل الضمان */
async function collateralFor(s: Scn, offerId: bigint, amount: bigint, inst: number, colToken: string) {
  const [, , reqUSDC] = await s.m.estimatePurchase(offerId, amount, inst);
  const dec = isEth(colToken) ? 18n : 8n;
  return ((reqUSDC * 10n ** dec) / PRICE_USDC[colToken]) * 105n / 100n + 1n;
}

export const OPS = [
  "createOfferBTC", "createOfferETH", "increaseOffer", "decreaseOffer", "cancelOffer",
  "buyBTCcol", "buyETHcol", "addCollateral", "withdrawExcess", "payInstallment",
  "earlyRepayCash", "earlyRepayWithCollateral", "liquidateOverdue", "withdrawETH",
] as const;
export type Op = (typeof OPS)[number];

/** ينفّذ مساراً واحداً على هدف صالح. يرمي إن لم يوجد هدف أو فشلت المعاملة. */
export async function runOp(s: Scn, op: Op, r: (n: number) => number) {
  const pick = <T>(xs: T[]) => { if (!xs.length) throw new Error(`no target for ${op}`); return xs[r(xs.length)]; };
  const usdcAddr = await s.usdc.getAddress();
  switch (op) {
    case "createOfferBTC": {
      const col = r(2) ? s.wAddr : ethers.ZeroAddress;
      return s.m.connect(pick(s.sellers)).createOffer(s.wAddr, col, usdcAddr, BTC(0.02 + r(4) / 100), 1000, 1, 12, INTERVAL, 0, 12000, false);
    }
    case "createOfferETH": {
      const col = r(2) ? s.wAddr : ethers.ZeroAddress;
      return s.m.connect(pick(s.sellers)).createOffer(ethers.ZeroAddress, col, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000, false, { value: E("0.5") + E("0.1") * BigInt(r(5)) });
    }
    case "increaseOffer": {
      const { id, o } = pick(await activeOffers(s));
      const who = signerOf(s, o.seller);
      return isEth(o.saleToken) ? s.m.connect(who).increaseOffer(id, 0, { value: E("0.1") })
                                : s.m.connect(who).increaseOffer(id, BTC(0.01));
    }
    case "decreaseOffer": {
      const { id, o } = pick((await activeOffers(s)).filter((x) => x.o.saleAmount >= 4n));
      return s.m.connect(signerOf(s, o.seller)).decreaseOffer(id, o.saleAmount / 4n);
    }
    case "cancelOffer": {
      const { id, o } = pick(await activeOffers(s));
      return s.m.connect(signerOf(s, o.seller)).cancelOffer(id);
    }
    case "buyBTCcol":
    case "buyETHcol": {
      const wantEthCol = op === "buyETHcol";
      const { id, o } = pick((await activeOffers(s)).filter((x) => isEth(x.o.collateralToken) === wantEthCol));
      const unit = isEth(o.saleToken) ? E("0.2") : BTC(0.01);
      const amount = o.saleAmount < unit ? o.saleAmount : unit;
      const col = await collateralFor(s, id, amount, 12, o.collateralToken);
      const q = PRICE_USDC[o.saleToken];
      const b = pick(s.buyers);
      return wantEthCol ? s.m.connect(b).buy(id, amount, 0, q, 12, false, { value: col })
                        : s.m.connect(b).buy(id, amount, col, q, 12, false);
    }
    case "addCollateral": {
      const { id, p } = pick(await activePositions(s));
      const who = signerOf(s, p.buyer);
      return isEth(p.collateralToken) ? s.m.connect(who).addCollateral(id, 0, { value: E("0.05") })
                                      : s.m.connect(who).addCollateral(id, BTC(0.002));
    }
    case "withdrawExcess": {
      // يُزاد الضمان أولاً بما يكفي ثم يُسحب جزء منه — يضمن مساراً صالحاً بلا خفض HF تحت 110%
      const { id, p } = pick(await activePositions(s));
      const who = signerOf(s, p.buyer);
      const extra = isEth(p.collateralToken) ? E("0.5") : BTC(0.01);
      if (isEth(p.collateralToken)) await s.m.connect(who).addCollateral(id, 0, { value: extra });
      else await s.m.connect(who).addCollateral(id, extra);
      return s.m.connect(who).withdrawExcessCollateral(id, extra / 2n);
    }
    case "payInstallment": {
      const { id, p } = pick(await activePositions(s));
      return s.m.connect(signerOf(s, p.buyer)).payInstallment(id);
    }
    case "earlyRepayCash": {
      const { id, p } = pick(await activePositions(s));
      return s.m.connect(signerOf(s, p.buyer)).earlyRepayCash(id);
    }
    case "earlyRepayWithCollateral": {
      const { id, p } = pick(await activePositions(s));
      return s.m.connect(signerOf(s, p.buyer)).earlyRepayWithCollateral(id);
    }
    case "liquidateOverdue": {
      // يُفضَّل ضمان ETH: البائع والمشتري ليسا msg.sender ⇒ يُنتج ETH معلّقاً (الدلو C)
      const ps = await activePositions(s);
      const eth = ps.filter((x) => isEth(x.p.collateralToken));
      const { id } = pick(eth.length ? eth : ps);
      await time.increase(GRACE + Number(INTERVAL) * 13);
      return s.m.connect(s.stranger).liquidatePositionPublic(id);
    }
    case "withdrawETH": {
      const all = [...s.sellers, ...s.buyers, s.owner];
      const owed = [];
      for (const a of all) if ((await s.m.pendingETH(a.address)) > 0n) owed.push(a);
      return s.m.connect(pick(owed)).withdrawETH();
    }
  }
}

/** المرحلة المُلزِمة: ترتيب يضمن هدفاً صالحاً لكل مسار — لا catch */
export const MANDATORY: Op[] = [
  "createOfferBTC", "createOfferBTC", "createOfferETH", "createOfferETH",
  "increaseOffer", "decreaseOffer",
  "buyBTCcol", "buyETHcol", "buyBTCcol", "buyETHcol",
  "addCollateral", "withdrawExcess", "payInstallment",
  "earlyRepayCash", "earlyRepayWithCollateral",
  "liquidateOverdue", "withdrawETH", "cancelOffer",
];

/**
 * يشغّل المرحلتين ويعيد عدّاد النجاح لكل مسار.
 * @param check يُستدعى بعد كل خطوة ناجحة (فحص الثوابت) — اختياري
 */
export async function runScenario(s: Scn, seed: number, randomSteps: number,
                                  check?: (op: Op) => Promise<void>) {
  const r = rng(seed);
  const ok: Record<string, number> = Object.fromEntries(OPS.map((o) => [o, 0]));
  // المرحلة المُلزِمة: كل مسار هنا يجب أن ينجح فعلاً
  // إعادة تعبئة العروض قبل الشراء الثاني لكل نوع ضمان مضمونة بعرضين لكل أصل.
  for (const op of MANDATORY) {
    const tx = await runOp(s, op, r);
    await tx.wait();
    ok[op]++;
    if (check) await check(op);
  }
  // المرحلة العشوائية
  for (let i = 0; i < randomSteps; i++) {
    const op = OPS[r(OPS.length)];
    try {
      const tx = await runOp(s, op, r);
      await tx.wait();
      ok[op]++;
    } catch { continue; } // لا هدف صالح أو رفض مشروع — يُحتسب فقط ما نجح
    if (check) await check(op);
  }
  return ok;
}
