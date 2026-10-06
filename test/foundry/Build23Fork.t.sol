// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MurabahaV6} from "../../contracts/MurabahaV6.sol";
import {Position, PositionState} from "../../contracts/libraries/MurabahaTypes.sol";

interface IFiatToken {
    function blacklist(address account) external;
    function blacklister() external view returns (address);
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title محاكاة ترقية Build 22 → Build 23 على نسخة محلية من Base mainnet (لا معاملات على الشبكة)
/// @notice يرقّي الـProxy الحي بانتحال الـSafe محلياً، ثم يعيد سيناريوهات F-1/F-2/F-3 من تقرير
///         «ايجنت اسلامي/05_تقرير_ثغرة_قسط.md» ويتحقق أنها لم تعد تنجح، وأن الحالة القائمة سليمة.
/// @dev يُتخطّى بلا BASE_FORK_URL. --evm-version cancun إلزامي: رموز Base الحية (USDC/cbBTC) تستعمل
///      PUSH0 وغيره، وإلا NotActivated. الـRPC العام بطيء ⇒ اختبار واحد في كل تشغيل:
///      BASE_FORK_URL=https://mainnet.base.org BASE_FORK_BLOCK=<n> \
///        forge test --match-test test_F1 --evm-version cancun -vv
contract Build23Fork is Test {
    address constant PROXY = 0xb2275E4aA2724D875a1a00206b40dD0fF188DEd5;
    address constant SAFE  = 0x64D738021BAe4cb9a7fd82529C2F94f61d404064;
    address constant USDC  = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant ETH   = address(0);

    MurabahaV6 q = MurabahaV6(payable(PROXY));
    address seller = makeAddr("seller");
    address buyer  = makeAddr("buyer");
    bool noFork;

    function setUp() public {
        string memory url = vm.envOr("BASE_FORK_URL", string(""));
        if (bytes(url).length == 0) { noFork = true; return; }
        uint256 blk = vm.envOr("BASE_FORK_BLOCK", uint256(0)); // تثبيت الكتلة يُثبّت ذاكرة RPC
        if (blk == 0) vm.createSelectFork(url); else vm.createSelectFork(url, blk);

        // الحالة قبل الترقية
        address owner0 = q.owner();
        uint256 nextOffer0 = q.nextOfferId();
        uint256 nextPos0 = q.nextPositionId();
        uint256 cap0 = q.globalCapUSDC();
        uint256 offerC0 = q.offerCustody(CBBTC);

        // الترقية: تنفيذ جديد (المكتبات تُنشر وتُربط آلياً)، بلا initializer — المتغيرات الجديدة تبدأ صفراً
        MurabahaV6 impl = new MurabahaV6();
        vm.prank(SAFE);
        q.upgradeToAndCall(address(impl), "");

        // الحالة بعد الترقية مطابقة
        assertEq(q.owner(), owner0, "owner");
        assertEq(q.nextOfferId(), nextOffer0, "nextOfferId");
        assertEq(q.nextPositionId(), nextPos0, "nextPositionId");
        assertEq(q.globalCapUSDC(), cap0, "globalCap");
        assertEq(q.offerCustody(CBBTC), offerC0, "offerCustody");
        console2.log("upgraded: state preserved, nextOfferId", nextOffer0);

        deal(CBBTC, seller, 0.01e8);
        deal(USDC, buyer, 10_000e6);
        vm.deal(buyer, 10 ether);
        vm.deal(seller, 1 ether);
    }

    /// عرض cbBTC بضمان ETH وسداد USDC — قسطان يومياً
    function _btcPosition() internal returns (uint256 pid) {
        vm.startPrank(seller);
        IERC20(CBBTC).approve(PROXY, type(uint256).max);
        uint256 offerId = q.createOffer(CBBTC, ETH, USDC, 0.001e8, 1000, 2, 2, 1 days, 0.001e8, 15000, false);
        vm.stopPrank();
        vm.startPrank(buyer);
        IERC20(USDC).approve(PROXY, type(uint256).max);
        pid = q.buy{value: 1 ether}(offerId, 0.001e8, 0, q.quotePrice(CBBTC), 2, false);
        vm.stopPrank();
    }

    function test_F1_fixed_blacklistedSeller_buyerCanStillPay() public {
        if (noFork) return;
        uint256 pid = _btcPosition();
        vm.prank(IFiatToken(USDC).blacklister());
        IFiatToken(USDC).blacklist(seller);
        vm.warp(block.timestamp + 1 days);
        _refreshFeeds();

        uint256 amt = q.getInstallmentAmount(pid);
        vm.prank(buyer);
        q.payInstallment(pid); // Build 22: revert «Blacklistable»
        assertEq(q.pendingToken(USDC, seller), amt);
        vm.prank(buyer);
        q.earlyRepayCash(pid); // Build 22: revert
        assertEq(uint8(q.getPosition(pid).state), uint8(PositionState.COMPLETED));
        console2.log("F-1 fixed: seller pending USDC =", q.pendingToken(USDC, seller));
    }

    function test_F2_fixed_blacklistedBuyerInCollateral_completes() public {
        if (noFork) return;
        vm.prank(seller);
        uint256 offerId = q.createOffer{value: 0.02 ether}(ETH, CBBTC, USDC, 0.02 ether, 1000, 1, 1, 1 days, 0.02 ether, 15000, false);
        address b2 = makeAddr("buyer2");
        deal(CBBTC, b2, 0.01e8);
        deal(USDC, b2, 10_000e6);
        vm.startPrank(b2);
        IERC20(CBBTC).approve(PROXY, type(uint256).max);
        IERC20(USDC).approve(PROXY, type(uint256).max);
        uint256 pid = q.buy(offerId, 0.02 ether, 0.002e8, q.quotePrice(ETH), 1, false);
        vm.stopPrank();

        vm.prank(IFiatToken(CBBTC).blacklister());
        IFiatToken(CBBTC).blacklist(b2);
        vm.warp(block.timestamp + 1 days);
        _refreshFeeds();

        vm.prank(b2);
        q.payInstallment(pid); // Build 22: revert — المركز كان يعلق
        assertEq(uint8(q.getPosition(pid).state), uint8(PositionState.COMPLETED));
        assertEq(q.pendingToken(CBBTC, b2), 0.002e8);
        console2.log("F-2 fixed: buyer pending cbBTC =", q.pendingToken(CBBTC, b2));
    }

    function test_F3_fixed_longPause_noLiquidationOnUnpause() public {
        if (noFork) return;
        uint256 pid = _btcPosition();
        vm.prank(SAFE);
        q.pause();
        vm.warp(block.timestamp + 1 days + 3 days + 1);
        _refreshFeeds();
        vm.prank(SAFE);
        q.unpause();
        (bool liq,) = q.isLiquidatable(pid);
        assertFalse(liq, "Build 22: true (overdue) right after unpause");
        vm.warp(block.timestamp + 3 days + 1);
        _refreshFeeds();
        (liq,) = q.isLiquidatable(pid);
        assertTrue(liq, "overdue after a full fresh grace");
        console2.log("F-3 fixed: fresh 3-day grace after unpause");
    }

    /// @dev Chainlink على الـfork لا يتحدّث مع vm.warp ← نُبقي آخر قراءة حديثة (المغذّيات المسجّلة فعلاً في قسط)
    function _refreshFeeds() internal {
        (address ethFeed,,,) = q.tokenConfigs(ETH);
        (address btcFeed,,,) = q.tokenConfigs(CBBTC);
        address[3] memory feeds = [ethFeed, btcFeed, q.sequencerUptimeFeed()];
        for (uint256 i; i < 3; ++i) {
            (uint80 r, int256 a, uint256 s,, uint80 ar) = IFeed(feeds[i]).latestRoundData();
            uint256 started = i == 2 ? s : block.timestamp;
            vm.mockCall(feeds[i], abi.encodeWithSelector(IFeed.latestRoundData.selector),
                abi.encode(r, a, started, block.timestamp, ar));
        }
    }
}
