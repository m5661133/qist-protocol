// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title MurabahaTypes — هياكل MurabahaV6 على مستوى الملف (Build 22)
 * @notice نُقلت من داخل العقد كما هي حرفاً بحرف (الحقول والترتيب والأنواع) حتى تستعملها
 *         CustodyLib دون استيراد دائري للعقد — الاستيراد الدائري كان يُسقط solcjs.
 * @dev    ⚠️ تخطيط التخزين يعتمد على ترتيب الحقول هنا — لا تُعِد ترتيبها ولا تُدرج في الوسط.
 *         النقل لا يغيّر التخطيط؛ يتحقق منه validateUpgrade في اختبار الترحيل.
 */

// ═══════════ D-019: إعدادات التوكن ═══════════

/**
 * @notice إعدادات توكن مدعوم
 * @param chainlinkFeed  مغذّي Chainlink للسعر بالـ USD (address(0) للستابل — سعره 1:1)
 * @param decimals       منازل الكسر (ETH=18، WBTC=8، USDC/USDT=6)
 * @param isStablecoin   true → للدفع فقط | false → للضمان/البيع فقط
 * @param active         هل هو مفعّل حالياً
 */
struct TokenConfig {
    address chainlinkFeed;
    uint8   decimals;
    bool    isStablecoin;
    bool    active;
}

// ═══════════ الهياكل ═══════════

enum OfferState    { ACTIVE, CLOSED }
enum PositionState { ACTIVE, COMPLETED, LIQUIDATED }

struct Offer {
    address seller;
    address saleToken;        // أصل البيع — address(0)=ETH
    address collateralToken;  // أصل الضمان — address(0)=ETH
    address paymentToken;     // الستابل كوين للدفع (USDC / USDT / ...)
    uint256 totalAmount;
    uint256 saleAmount;
    uint256 minPurchaseAmount;
    uint16  profitBps;
    uint8   minInstallments;
    uint8   maxInstallments;
    uint32  paymentInterval;
    uint16  collateralRatioBps;
    OfferState state;
    bool    autoLiquidateEnabled; // FB-60: البائع اختار التصفية التلقائية مقابل رسوم
}

struct Position {
    uint256 offerId;
    address buyer;
    address saleToken;
    address collateralToken;
    address paymentToken;
    uint256 saleAmount;
    uint256 collateralAmount;
    uint256 totalPayable;
    uint8   totalInstallments;
    uint8   paidInstallments;
    uint32  paymentInterval;
    uint256 nextDueDate;
    PositionState state;
    bool    autoPayEnabled; // FB-60: المشتري اختار الدفع التلقائي مقابل رسوم
}
