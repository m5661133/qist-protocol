// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IChainlinkFeed} from "../interfaces/IChainlinkFeed.sol";
import {Errors} from "./Errors.sol";

/**
 * @title PriceLib — منطق أسعار Chainlink الموحّد
 * @notice يحل التكرار الموثق: getETHPriceUSDC كانت مكتوبة في V3:148 و V4:214 و V5:195.
 *         الآن مكان واحد — إصلاح واحد يصلح كل الإصدارات.
 *
 * @dev تحسينات على الكود الأصلي:
 *      1. CODE-V5 (MED-4): يقرأ decimals() فعلياً بدل افتراض 8 دائماً.
 *      2. يفحص staleness و answer<=0 (موجود في الأصل، محفوظ).
 *
 * الاصطلاح: كل الأسعار تُرجع بـ 6 decimals (مثل USDC). مثال: ETH=$2000 → 2_000_000000.
 */
library PriceLib {
    uint256 internal constant MAX_PRICE_AGE = 1 hours;
    uint256 internal constant USDC_DECIMALS = 6;
    /// @dev H2: مهلة تعافي L2 Sequencer بعد عودته قبل الوثوق بالأسعار (توصية Chainlink)
    uint256 internal constant SEQUENCER_GRACE_PERIOD = 1 hours;

    /**
     * @notice سعر وحدة واحدة من الأصل بـ USDC (6 decimals)
     * @param feed مغذّي Chainlink (ETH/USD أو BTC/USD)
     * @return price السعر بـ 6 decimals
     */
    function priceUSDC(IChainlinkFeed feed) internal view returns (uint256 price) {
        // slither-disable-next-line unused-return — roundId/startedAt/answeredInRound غير مطلوبة
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert Errors.StalePrice();
        if (answer <= 0) revert Errors.StalePrice();

        // تحويل ديناميكي بدل القسمة الثابتة /100 (إصلاح MED-4)
        uint8 feedDecimals = feed.decimals();
        if (feedDecimals >= USDC_DECIMALS) {
            price = uint256(answer) / (10 ** (feedDecimals - USDC_DECIMALS));
        } else {
            price = uint256(answer) * (10 ** (USDC_DECIMALS - feedDecimals));
        }
    }

    /**
     * @notice H2: يتحقق أن L2 Sequencer يعمل وتجاوز مهلة التعافي (لـ Base/Optimism)
     * @dev answer: 0 = يعمل، 1 = متوقّف. startedAt = وقت آخر تغيّر للحالة.
     *      يُرفض السعر إن كان الـ sequencer متوقّفاً أو عاد للتوّ ضمن مهلة التعافي.
     * @param sequencer مغذّي Chainlink L2 Sequencer Uptime
     */
    function requireSequencerUp(IChainlinkFeed sequencer) internal view {
        (, int256 up, uint256 startedAt,,) = sequencer.latestRoundData();
        if (up != 0 || startedAt == 0) revert Errors.SequencerDown(); // startedAt==0 = جولة غير صالحة
        if (block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) revert Errors.SequencerGracePeriodNotOver();
    }

    /**
     * @notice يحوّل كمية من الأصل إلى قيمتها بـ USDC
     * @param amount كمية الأصل (بـ decimals الأصل)
     * @param price سعر الوحدة بـ USDC (6 decimals)
     * @param assetDecimals منازل الأصل (ETH=18, WBTC=8)
     */
    function assetToUSDC(
        uint256 amount,
        uint256 price,
        uint256 assetDecimals
    ) internal pure returns (uint256) {
        return (amount * price) / (10 ** assetDecimals);
    }

    /**
     * @notice يحوّل قيمة بـ USDC إلى كمية مقابلة من الأصل
     * @param usdcAmount القيمة بـ USDC (6 decimals)
     * @param price سعر الوحدة بـ USDC (6 decimals)
     * @param assetDecimals منازل الأصل (ETH=18, WBTC=8)
     */
    /**
     * @notice يحوّل قيمة بـ USDC إلى كمية مقابلة من الأصل
     */
    function usdcToAsset(
        uint256 usdcAmount,
        uint256 price,
        uint256 assetDecimals
    ) internal pure returns (uint256) {
        if (price == 0) revert Errors.StalePrice();
        return (usdcAmount * (10 ** assetDecimals)) / price;
    }

    /**
     * @notice D-018: يتحقق أن السعر الحالي ضمن سقف انزلاق عن السعر المُقتبَس.
     * @dev يحمي من sandwich/price-manipulation. يُرفض لو تحرّك أكثر من toleranceBps.
     * @param quotedPrice السعر الذي رآه المشتري ووافق عليه
     * @param currentPrice سعر Chainlink لحظة التنفيذ
     * @param toleranceBps السقف بالنقاط الأساسية (100 = 1%)
     */
    function checkSlippage(
        uint256 quotedPrice,
        uint256 currentPrice,
        uint256 toleranceBps
    ) internal pure {
        if (quotedPrice == 0) revert Errors.InvalidParams();
        uint256 diff = currentPrice > quotedPrice
            ? currentPrice - quotedPrice
            : quotedPrice - currentPrice;
        // diff/quoted > tolerance → رفض
        if (diff * 10000 > quotedPrice * toleranceBps) {
            revert Errors.SlippageExceeded(quotedPrice, currentPrice);
        }
    }
}
