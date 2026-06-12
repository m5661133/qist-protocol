import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * اختبارات V6 — Multi-Token Architecture
 * address(0) = ETH, WBTC = ERC-20، الدفع بـ USDC (ستابل)
 */

const U   = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = (n: number) => BigInt(Math.round(n * 1e8));
const Q   = 60000n * 10n ** 6n;  // سعر BTC بـ USDC (6 dec)
const QE  = 3000n  * 10n ** 6n;  // سعر ETH بـ USDC (6 dec)
const INTERVAL   = 60n;
const INTERVAL_N = 60;
const GRACE      = 259200;    // GRACE_PERIOD = 3 أيام (الإنتاج)

const ETH_ADDR  = ethers.ZeroAddress; // address(0)

async function deploy() {
  const [owner, seller, buyer, keeper] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  const MockWBTC = await ethers.getContractFactory("MockWBTC");
  const wbtc = await MockWBTC.deploy();
  const MockFeed = await ethers.getContractFactory("MockFeed");
  const ethFeed = await MockFeed.deploy(300000000000n, 8); // $3000
  const btcFeed = await MockFeed.deploy(6000000000000n, 8); // $60000

  const Murabaha = await ethers.getContractFactory("MurabahaV6");
  const m = await upgrades.deployProxy(Murabaha, [
    await usdc.getAddress(), await wbtc.getAddress(),
    await ethFeed.getAddress(), await btcFeed.getAddress(),
    owner.address, owner.address
  ], { kind: "uups", unsafeAllow: ["constructor"] });

  await wbtc.mint(seller.address, BTC(10));
  await wbtc.mint(buyer.address,  BTC(5));
  await usdc.mint(buyer.address,  U(500000));

  const usdcAddr = await usdc.getAddress();
  const wbtcAddr = await wbtc.getAddress();

  return { m, usdc, wbtc, ethFeed, btcFeed, owner, seller, buyer, keeper, usdcAddr, wbtcAddr };
}

// ═══ مسار WBTC كاملاً ═══
describe("MurabahaV6 Multi-Token — مسار WBTC كاملاً", () => {
  it("دورة حياة كاملة: عرض WBTC + ضمان WBTC → 12 قسطاً → إرجاع الضمان", async () => {
    const { m, usdc, wbtc, seller, buyer, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    // createOffer(saleToken, collateralToken, paymentToken, saleAmount, profit, minI, maxI, interval, minPurchase, ratio)
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);

    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await usdc.connect(buyer).approve(mAddr, U(200000));
    // buy(offerId, purchaseAmount, collateralAmount, quotedPrice, installments)
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q, 12, false);

    const colBefore = await wbtc.balanceOf(buyer.address);
    for (let i = 0; i < 12; i++) await m.connect(buyer).payInstallment(1);

    const p = await m.getPosition(1);
    expect(p.state).to.equal(1); // COMPLETED
    expect(p.collateralAmount).to.equal(0n);
    expect((await wbtc.balanceOf(buyer.address)) - colBefore).to.equal(BTC(1.5));
  });
});

// ═══ مسار ETH ═══
describe("MurabahaV6 Multi-Token — مسار ETH", () => {
  it("بائع يعرض ETH + مشتري يرهن WBTC ويستلم ETH فوراً", async () => {
    const { m, wbtc, seller, buyer, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    // عرض ETH (saleToken=address(0)) مع ضمان WBTC
    await m.connect(seller).createOffer(
      ETH_ADDR, wbtcAddr, usdcAddr, 0, 1000, 1, 12, INTERVAL, 0, 12000,
      false,
      { value: ethers.parseEther("1") }
    );
    await wbtc.connect(buyer).approve(mAddr, BTC(5));

    const ethBefore = await ethers.provider.getBalance(buyer.address);
    const txBuy = await m.connect(buyer).buy(1, ethers.parseEther("1"), BTC(2), QE, 12, false);
    const rcBuy = await txBuy.wait();
    const gasBuy = rcBuy!.gasUsed * rcBuy!.gasPrice;

    expect(await m.pendingETH(buyer.address)).to.equal(0n);
    expect((await ethers.provider.getBalance(buyer.address)) - ethBefore + gasBuy)
      .to.equal(ethers.parseEther("0.98")); // 2% رسوم إجمالية
  });

  it("عقد WBTC بضمان ETH → إكمال يُرجع ETH مباشرة", async () => {
    const { m, usdc, wbtc, seller, buyer, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, ETH_ADDR, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await usdc.connect(buyer).approve(mAddr, U(200000));
    await m.connect(buyer).buy(1, BTC(1), 0, Q, 12, false, { value: ethers.parseEther("30") });

    const ethBefore = await ethers.provider.getBalance(buyer.address);
    let totalGas = 0n;
    for (let i = 0; i < 12; i++) {
      const tx = await m.connect(buyer).payInstallment(1);
      const rc = await tx.wait();
      totalGas += rc!.gasUsed * rc!.gasPrice;
    }
    expect(await m.pendingETH(buyer.address)).to.equal(0n);
    expect((await ethers.provider.getBalance(buyer.address)) - ethBefore + totalGas)
      .to.be.closeTo(ethers.parseEther("30"), ethers.parseEther("0.01"));
  });
});

// ═══ التصفية والوقت ═══
describe("MurabahaV6 Multi-Token — التصفية والوقت", () => {
  it("تصفية بعد تجاوز المهلة", async () => {
    const { m, usdc, wbtc, owner, seller, buyer, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q, 12, false);

    await time.increase(INTERVAL_N + GRACE + 3600);
    const [ok, reason] = await m.isLiquidatable(1);
    expect(ok).to.equal(true);
    expect(reason).to.equal("overdue");

    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(owner).performUpkeep(data);
    expect((await m.getPosition(1)).state).to.equal(2); // LIQUIDATED
  });

  it("لا تصفية ضمن المهلة (يومان فقط)", async () => {
    const { m, wbtc, seller, buyer, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q, 12, false);

    await time.increase(INTERVAL_N + 60); // 60 ثانية (أقل من GRACE=120)
    const [ok] = await m.isLiquidatable(1);
    expect(ok).to.equal(false);
  });

  it("performUpkeep يخصم القسط تلقائياً (D-010)", async () => {
    const { m, usdc, wbtc, owner, seller, buyer, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);
    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await usdc.connect(buyer).approve(mAddr, U(200000));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q, 12, false);

    await time.increase(INTERVAL_N + 100);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    await m.connect(owner).performUpkeep(data);
    expect((await m.getPosition(1)).paidInstallments).to.equal(1n);
  });
});

// ═══ Multi-Token: addSupportedToken ═══
describe("MurabahaV6 Multi-Token — addSupportedToken", () => {
  it("المالك يضيف USDT ويُنشئ عرض بدفع USDT", async () => {
    const { m, wbtc, owner, seller, buyer, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    // نشر MockUSDT (6 decimals)
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdt = await MockUSDC.deploy(); // نفس 6 decimals
    const usdtAddr = await usdt.getAddress();

    // إضافة USDT كستابل (isStablecoin=true, feed=address(0))
    await m.connect(owner).addSupportedToken(usdtAddr, ethers.ZeroAddress, 6, true);

    const cfg = await m.tokenConfigs(usdtAddr);
    expect(cfg.active).to.equal(true);
    expect(cfg.isStablecoin).to.equal(true);

    // إنشاء عرض بدفع USDT
    await wbtc.connect(seller).approve(mAddr, BTC(10));
    await m.connect(seller).createOffer(wbtcAddr, wbtcAddr, usdtAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false);

    // شراء وسداد قسط بـ USDT
    await wbtc.connect(buyer).approve(mAddr, BTC(5));
    await usdt.mint(buyer.address, U(500000));
    await usdt.connect(buyer).approve(mAddr, U(200000));
    await m.connect(buyer).buy(1, BTC(1), BTC(1.5), Q, 12, false);
    await m.connect(buyer).payInstallment(1);

    expect((await m.getPosition(1)).paidInstallments).to.equal(1n);
  });

  it("توكن غير ستابل للدفع يُرفض (NotStablecoin)", async () => {
    const { m, wbtc, seller, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    await wbtc.connect(seller).approve(mAddr, BTC(10));
    // paymentToken = WBTC (ليس ستابل) → يجب أن يُرفض
    await expect(
      m.connect(seller).createOffer(wbtcAddr, wbtcAddr, wbtcAddr, BTC(1), 1000, 1, 12, INTERVAL, 0, 12000, false)
    ).to.be.revertedWithCustomError(m, "NotStablecoin");
  });

  it("ستابل كوين كأصل بيع يُرفض (IsStablecoin)", async () => {
    const { m, wbtc, seller, usdcAddr, wbtcAddr } = await deploy();
    const mAddr = await m.getAddress();

    // saleToken = USDC (ستابل) → يجب أن يُرفض
    await expect(
      m.connect(seller).createOffer(usdcAddr, wbtcAddr, usdcAddr, 1000000n, 1000, 1, 12, INTERVAL, 0, 12000, false)
    ).to.be.revertedWithCustomError(m, "IsStablecoin");
  });

  it("getSupportedTokens تُرجع ETH + WBTC + USDC", async () => {
    const { m, usdcAddr, wbtcAddr } = await deploy();
    const tokens = await m.getSupportedTokens();
    expect(tokens).to.include(ETH_ADDR);
    expect(tokens).to.include(wbtcAddr);
    expect(tokens).to.include(usdcAddr);
  });
});
