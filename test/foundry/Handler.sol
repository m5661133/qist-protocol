// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MurabahaV6} from "../../contracts/MurabahaV6.sol";
import {MockUSDC, MockWBTC, MockFeed} from "../../contracts/Mocks.sol";

/// @title Handler — يقود دورة حياة العقد بمدخلات محدودة (bounded) لحملة الثوابت.
/// @dev عالم مبسّط: البيع + الضمان = WBTC، الدفع = USDC (يتجنّب تعقيد ETH push/pull).
///      كل نداء يُلَفّ بـ try/catch: الرفض المشروع (ضمان ناقص، ليس مستحقاً…) لا يكسر الحملة.
contract Handler is Test {
    MurabahaV6 public m;
    MockUSDC  public usdc;
    MockWBTC  public wbtc;
    MockFeed  public btcFeed;

    uint256 public constant NUM_ACTORS = 4;
    address[] public actors;

    // إحصاءات لكشف «الحملة لم تفعل شيئاً» + تأكيد التغطية
    uint256 public callsCreate;
    uint256 public callsBuy;
    uint256 public callsPay;
    uint256 public callsEarly;
    uint256 public callsLiquidate;
    uint256 public settlementChecks; // كم مرة تحقّقنا من حفظ الضمان عند التسوية
    bool    public brokenSettlement; // يُرفع إن كسرت تصفيةٌ ثابتَ التسوية (يُفحَص في طبقة الثابت — لا يُبتلع)

    constructor(MurabahaV6 _m, MockUSDC _usdc, MockWBTC _wbtc, MockFeed _btcFeed) {
        m = _m; usdc = _usdc; wbtc = _wbtc; btcFeed = _btcFeed;
        for (uint256 i = 0; i < NUM_ACTORS; i++) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            usdc.mint(a, 50_000_000e6); // 50M USDC
            wbtc.mint(a, 100_000e8);    // 100k WBTC
            vm.startPrank(a);
            usdc.approve(address(m), type(uint256).max);
            wbtc.approve(address(m), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % NUM_ACTORS];
    }

    // ═══════════ الأفعال ═══════════

    function h_createOffer(
        uint256 sellerSeed, uint256 saleAmt,
        uint16 profitBps, uint8 minInst, uint8 maxInst, uint16 ratioBps
    ) public {
        address seller = _actor(sellerSeed);
        saleAmt   = bound(saleAmt, 1e5, 5e8);            // 0.001 .. 5 WBTC
        maxInst   = uint8(bound(maxInst, 1, 12));
        minInst   = uint8(bound(minInst, 1, maxInst));
        profitBps = uint16(bound(profitBps, 0, m.MAX_PROFIT_BPS()));
        ratioBps  = uint16(bound(ratioBps, 11000, 20000));
        if (wbtc.balanceOf(seller) < saleAmt) return;
        vm.prank(seller);
        try m.createOffer(
            address(wbtc), address(wbtc), address(usdc),
            saleAmt, profitBps, minInst, maxInst, 1 days, 0, ratioBps, false
        ) { callsCreate++; } catch {}
    }

    function h_buy(
        uint256 buyerSeed, uint256 offerSeed, uint256 purchaseSeed, uint8 instSeed
    ) public {
        uint256 no = m.nextOfferId();
        if (no <= 1) return;
        uint256 offerId = bound(offerSeed, 1, no - 1);

        (address seller,,,,, uint256 sAmt,,, uint8 minI, uint8 maxI,,, MurabahaV6.OfferState st,) = m.offers(offerId);
        if (st != MurabahaV6.OfferState.ACTIVE || sAmt == 0) return; // ليس ACTIVE أو فارغ

        address buyer = _actor(buyerSeed);
        if (buyer == seller) buyer = _actor(buyerSeed + 1); // منع Self-Buy
        if (buyer == seller) return;

        uint256 purchase = bound(purchaseSeed, 1, sAmt);
        uint8 inst = uint8(bound(instSeed, minI, maxI));

        // ضمان سخيّ يكفي أسوأ نسبة (سعر متطابق للبيع والضمان WBTC): purchase × ~10
        uint256 collateral = purchase * 10;
        if (wbtc.balanceOf(buyer) < collateral) return;

        uint256 quoted = m.quotePrice(address(wbtc)); // بلا انزلاق

        vm.prank(buyer);
        try m.buy(offerId, purchase, collateral, quoted, inst, false) { callsBuy++; } catch {}
    }

    function h_payInstallment(uint256 posSeed) public {
        uint256 np = m.nextPositionId();
        if (np <= 1) return;
        uint256 pid = bound(posSeed, 1, np - 1);
        (, address buyer,,,,,,,,,,, MurabahaV6.PositionState pst,) = m.positions(pid);
        if (pst != MurabahaV6.PositionState.ACTIVE) return; // ليس ACTIVE
        vm.prank(buyer);
        try m.payInstallment(pid) { callsPay++; } catch {}
    }

    function h_earlyRepayCash(uint256 posSeed) public {
        uint256 np = m.nextPositionId();
        if (np <= 1) return;
        uint256 pid = bound(posSeed, 1, np - 1);
        (, address buyer,,,,,,,,,,, MurabahaV6.PositionState pst,) = m.positions(pid);
        if (pst != MurabahaV6.PositionState.ACTIVE) return;
        vm.prank(buyer);
        try m.earlyRepayCash(pid) { callsEarly++; } catch {}
    }

    function h_addCollateral(uint256 posSeed, uint256 amt) public {
        uint256 np = m.nextPositionId();
        if (np <= 1) return;
        uint256 pid = bound(posSeed, 1, np - 1);
        (, address buyer,,,,,,,,,,, MurabahaV6.PositionState pst,) = m.positions(pid);
        if (pst != MurabahaV6.PositionState.ACTIVE) return;
        amt = bound(amt, 1, 1e8);
        if (wbtc.balanceOf(buyer) < amt) return;
        vm.prank(buyer);
        try m.addCollateral(pid, amt) {} catch {}
    }

    function h_withdrawExcess(uint256 posSeed, uint256 amt) public {
        uint256 np = m.nextPositionId();
        if (np <= 1) return;
        uint256 pid = bound(posSeed, 1, np - 1);
        (, address buyer,,,,, uint256 col,,,,,, MurabahaV6.PositionState pst,) = m.positions(pid);
        if (pst != MurabahaV6.PositionState.ACTIVE || col == 0) return;
        amt = bound(amt, 1, col);
        vm.prank(buyer);
        try m.withdrawExcessCollateral(pid, amt) {} catch {}
    }

    function h_warp(uint256 secs) public {
        secs = bound(secs, 1 hours, 10 days);
        vm.warp(block.timestamp + secs);
    }

    function h_movePrice(uint256 priceSeed) public {
        // يحرّك سعر WBTC لاختبار التصفية (تحت الضمان) — يبقى طازجاً (MockFeed=block.timestamp)
        int256 p = int256(bound(priceSeed, 10_000e8, 120_000e8));
        btcFeed.setAnswer(p);
    }

    function h_liquidate(uint256 callerSeed, uint256 posSeed) public {
        uint256 np = m.nextPositionId();
        if (np <= 1) return;
        uint256 pid = bound(posSeed, 1, np - 1);
        (, address buyer,,,, , uint256 colBefore,,,,,, MurabahaV6.PositionState pst,) = m.positions(pid);
        if (pst != MurabahaV6.PositionState.ACTIVE) return;
        address caller = _actor(callerSeed);
        vm.prank(caller);
        try m.liquidatePositionPublic(pid) {
            callsLiquidate++;
            // ثابت التسوية: بعد التصفية collateralAmount = 0، والحالة LIQUIDATED (لا خلق/إتلاف).
            // نرفع علماً بدل assert (كي لا يُبتلع تحت fail_on_revert=false) — يُفحَص في invariant_I6.
            (,,,,,, uint256 colAfter,,,,,, MurabahaV6.PositionState pst2,) = m.positions(pid);
            if (colAfter != 0 || pst2 != MurabahaV6.PositionState.LIQUIDATED) brokenSettlement = true;
            settlementChecks++;
            buyer; colBefore;
        } catch {}
    }
}
