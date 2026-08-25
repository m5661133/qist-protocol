// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MurabahaV6} from "../../contracts/MurabahaV6.sol";
import {MockUSDC, MockWBTC, MockFeed} from "../../contracts/Mocks.sol";
import {Handler} from "./Handler.sol";

/// @title حملة الثوابت لـ MurabahaV6 — عالم WBTC (بيع+ضمان) + USDC (دفع).
/// @notice تُثبت خمسة ثوابت أمنية/محاسبية عبر آلاف الاستدعاءات العشوائية:
///   I1 الملاءة بالضمان: رصيد WBTC للعقد ≥ (مخزون العروض الباقي + ضمانات المراكز).
///   I2 لا احتجاز USDC: الأقساط تُمرَّر فوراً للبائع → رصيد USDC للعقد = 0.
///   I3 لا ETH معلّق شبحي: totalPendingETH = 0 (لا ETH في هذا العالم).
///   I4 سلامة الأقساط: paidInstallments ≤ totalInstallments لكل مركز.
///   I5 سلامة العرض: saleAmount ≤ totalAmount لكل عرض.
contract MurabahaInvariant is Test {
    MurabahaV6 m;
    MockUSDC usdc;
    MockWBTC wbtc;
    MockFeed ethFeed;
    MockFeed btcFeed;
    Handler handler;

    address constant BROKER   = address(0xB0B);
    address constant PROTOCOL = address(0xC0DE);

    function setUp() public {
        usdc    = new MockUSDC();
        wbtc    = new MockWBTC();
        ethFeed = new MockFeed(2_000e8, 8);
        btcFeed = new MockFeed(60_000e8, 8);

        MurabahaV6 impl = new MurabahaV6();
        bytes memory initData = abi.encodeCall(
            MurabahaV6.initialize,
            (address(usdc), address(wbtc), address(ethFeed), address(btcFeed), BROKER, PROTOCOL)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        m = MurabahaV6(payable(address(proxy)));

        handler = new Handler(m, usdc, wbtc, btcFeed);

        // استهدف الـ Handler فقط (لا نداءات مباشرة عشوائية على العقد)
        targetContract(address(handler));
    }

    // ═══════════ الثوابت ═══════════

    /// I1 — الملاءة: العقد يملك دائماً ما يكفي من WBTC لتغطية المخزون + الضمانات المقفلة.
    function invariant_I1_wbtcSolvency() public view {
        uint256 required;
        uint256 no = m.nextOfferId();
        for (uint256 i = 1; i < no; i++) required += _offerSaleAmount(i);
        uint256 np = m.nextPositionId();
        for (uint256 i = 1; i < np; i++) required += _posCollateral(i);
        assertGe(wbtc.balanceOf(address(m)), required, "I1: WBTC insolvent");
    }

    /// I2 — العقد لا يحتجز USDC (الأقساط تُمرَّر فوراً للبائع + رسوم الأتمتة للبروتوكول).
    function invariant_I2_noUsdcHeld() public view {
        assertEq(usdc.balanceOf(address(m)), 0, "I2: contract retains USDC");
    }

    /// I3 — لا التزامات ETH معلّقة (عالم WBTC/USDC بحت).
    function invariant_I3_noPendingEth() public view {
        assertEq(m.totalPendingETH(), 0, "I3: unexpected pending ETH");
        assertEq(address(m).balance, 0, "I3: unexpected ETH balance");
    }

    /// I4 — سلامة الأقساط لكل مركز.
    function invariant_I4_installmentIntegrity() public view {
        uint256 np = m.nextPositionId();
        for (uint256 i = 1; i < np; i++) {
            (uint8 total, uint8 paid) = _posInstallments(i);
            assertLe(paid, total, "I4: paid > total installments");
        }
    }

    /// I5 — سلامة العرض: المتبقّي لا يتجاوز الأصلي.
    function invariant_I5_offerIntegrity() public view {
        uint256 no = m.nextOfferId();
        for (uint256 i = 1; i < no; i++) {
            (uint256 total, uint256 remaining) = _offerAmounts(i);
            assertLe(remaining, total, "I5: saleAmount > totalAmount");
        }
    }

    /// I6 — كل تصفية تمّت صفّرت الضمان وضبطت الحالة LIQUIDATED (لا خلق/إتلاف قيمة).
    function invariant_I6_settlementConservation() public view {
        assertFalse(handler.brokenSettlement(), "I6: liquidation broke settlement invariant");
    }

    /// @dev ملخّص تغطية الحملة — يظهر مع -vvv؛ يضمن أن الأفعال نُفّذت فعلاً.
    function invariant_callSummary() public view {
        console2.log("createOffer:", handler.callsCreate());
        console2.log("buy:        ", handler.callsBuy());
        console2.log("payInst:    ", handler.callsPay());
        console2.log("earlyRepay: ", handler.callsEarly());
        console2.log("liquidate:  ", handler.callsLiquidate());
        console2.log("settleCheck:", handler.settlementChecks());
        assertTrue(true);
    }

    // ═══════════ اختبار دورة حياة محدّد (تشخيص + إثبات الميكانيكا) ═══════════

    function test_lifecycle_createBuyPayComplete() public {
        address seller = address(0x5E11E7);
        address buyer  = address(0xB0417E5);
        wbtc.mint(seller, 10e8);
        wbtc.mint(buyer, 100e8);
        usdc.mint(buyer, 10_000_000e6);
        vm.prank(seller); wbtc.approve(address(m), type(uint256).max);
        vm.startPrank(buyer);
        wbtc.approve(address(m), type(uint256).max);
        usdc.approve(address(m), type(uint256).max);
        vm.stopPrank();

        // عرض: بيع 1 WBTC، ربح 10%، 1..3 أقساط، ضمان 150%
        vm.prank(seller);
        uint256 offerId = m.createOffer(
            address(wbtc), address(wbtc), address(usdc),
            1e8, 1000, 1, 3, 1 days, 0, 15000, false
        );
        assertEq(offerId, 1);

        uint256 quoted = m.quotePrice(address(wbtc));
        vm.prank(buyer);
        uint256 pid = m.buy(offerId, 1e8, 3e8, quoted, 3, false); // ضمان 3 WBTC، 3 أقساط
        assertEq(pid, 1, "buy failed");

        // ادفع كل الأقساط
        for (uint256 k = 0; k < 3; k++) {
            vm.warp(block.timestamp + 1 days);
            vm.prank(buyer);
            m.payInstallment(pid);
        }
        (uint8 total, uint8 paid) = _posInstallments(pid);
        assertEq(paid, total, "not fully paid");
        assertEq(usdc.balanceOf(address(m)), 0, "USDC stuck");
    }

    function test_lifecycle_liquidation() public {
        address seller = address(0x5E11E7);
        address buyer  = address(0xB0417E5);
        wbtc.mint(seller, 10e8);
        wbtc.mint(buyer, 100e8);
        usdc.mint(buyer, 10_000_000e6);
        vm.prank(seller); wbtc.approve(address(m), type(uint256).max);
        vm.startPrank(buyer);
        wbtc.approve(address(m), type(uint256).max);
        usdc.approve(address(m), type(uint256).max);
        vm.stopPrank();

        vm.prank(seller);
        uint256 offerId = m.createOffer(
            address(wbtc), address(wbtc), address(usdc),
            1e8, 1000, 1, 3, 1 days, 0, 12000, false
        );
        uint256 quoted = m.quotePrice(address(wbtc));
        vm.prank(buyer);
        uint256 pid = m.buy(offerId, 1e8, 13e7, quoted, 3, false); // ضمان 1.3 WBTC (110%+)

        // تجاوز مهلة السماح → متأخّر → قابل للتصفية
        vm.warp(block.timestamp + 1 days + m.GRACE_PERIOD() + 1);
        (bool can,) = m.isLiquidatable(pid);
        assertTrue(can, "should be liquidatable (overdue)");
        m.liquidatePositionPublic(pid);
        (,,,,,, uint256 colAfter,,,,,, MurabahaV6.PositionState st,) = m.positions(pid);
        assertEq(colAfter, 0);
        assertTrue(st == MurabahaV6.PositionState.LIQUIDATED);
    }

    // ═══════════ مساعدات قراءة الـ getters (بنية الـ struct ثابتة) ═══════════

    // Offer: [0]seller [1]saleTok [2]colTok [3]payTok [4]totalAmount [5]saleAmount
    //        [6]minPurchase [7]profitBps [8]minInst [9]maxInst [10]interval [11]ratio [12]state [13]autoLiq
    function _offerSaleAmount(uint256 id) internal view returns (uint256 s) {
        (,,,,, s,,,,,,,,) = m.offers(id);
    }
    function _offerAmounts(uint256 id) internal view returns (uint256 total, uint256 remaining) {
        (,,,, total, remaining,,,,,,,,) = m.offers(id);
    }

    // Position: [0]offerId [1]buyer [2]saleTok [3]colTok [4]payTok [5]saleAmount [6]collateralAmount
    //           [7]totalPayable [8]totalInst [9]paidInst [10]interval [11]nextDue [12]state [13]autoPay
    function _posCollateral(uint256 id) internal view returns (uint256 c) {
        (,,,,,, c,,,,,,,) = m.positions(id);
    }
    function _posInstallments(uint256 id) internal view returns (uint8 total, uint8 paid) {
        (,,,,,,, , total, paid,,,,) = m.positions(id);
    }
}
