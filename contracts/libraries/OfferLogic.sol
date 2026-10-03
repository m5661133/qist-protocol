// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Errors} from "./Errors.sol";
import {Offer, OfferState} from "./MurabahaTypes.sol";

/**
 * @title OfferLogic — فحص معاملات العرض وكتابته (Build 22)
 * @notice مكتبة **خارجية مربوطة** (delegatecall، msg.sender = البائع). محتوى MurabahaV6._createOffer
 *         منقول حرفياً وبنفس ترتيب الأخطاء. فحوصات الرموز والتحويل الوارد قبله والحدث بعده
 *         باقية في العقد. الثوابت هنا مصدرها الوحيد — العقد يعرّف ثوابته العامة منها.
 */
library OfferLogic {
    uint16 internal constant MIN_COLLATERAL_RATIO_BPS = 11000; // 110%
    uint16 internal constant MAX_COLLATERAL_RATIO_BPS = 20000; // 200%
    uint16 internal constant MAX_PROFIT_BPS           = 30000; // 300%
    uint32 internal constant MIN_PAYMENT_INTERVAL     = 60;
    uint32 internal constant MAX_PAYMENT_INTERVAL     = 365 days;

    struct NewOffer {
        address saleToken;
        address collateralToken;
        address paymentToken;
        uint256 saleAmount;
        uint16  profitBps;
        uint8   minInstallments;
        uint8   maxInstallments;
        uint32  paymentInterval;
        uint256 minPurchaseAmount;
        uint16  collateralRatioBps;
        bool    enableAutoLiquidate;
    }

    function record(
        mapping(uint256 => Offer) storage offers,
        mapping(address => uint256[]) storage sellerOffers,
        uint256 offerId,
        NewOffer memory n
    ) external {
        if (n.saleAmount == 0 || n.maxInstallments == 0 || n.minInstallments == 0) revert Errors.InvalidParams();
        if (n.minInstallments > n.maxInstallments)          revert Errors.InvalidParams();
        if (n.profitBps > MAX_PROFIT_BPS)                   revert Errors.InvalidParams();
        if (n.collateralRatioBps < MIN_COLLATERAL_RATIO_BPS) revert Errors.InvalidParams(); // < 110%
        if (n.collateralRatioBps > MAX_COLLATERAL_RATIO_BPS) revert Errors.InvalidParams(); // > 200%
        if (n.paymentInterval < MIN_PAYMENT_INTERVAL)       revert Errors.InvalidParams();
        if (n.paymentInterval > MAX_PAYMENT_INTERVAL)       revert Errors.InvalidParams();

        offers[offerId] = Offer({
            seller: msg.sender, saleToken: n.saleToken, collateralToken: n.collateralToken,
            paymentToken: n.paymentToken, totalAmount: n.saleAmount, saleAmount: n.saleAmount,
            minPurchaseAmount: n.minPurchaseAmount, profitBps: n.profitBps,
            minInstallments: n.minInstallments, maxInstallments: n.maxInstallments,
            paymentInterval: n.paymentInterval, collateralRatioBps: n.collateralRatioBps,
            state: OfferState.ACTIVE,
            autoLiquidateEnabled: n.enableAutoLiquidate  // FB-60
        });
        sellerOffers[msg.sender].push(offerId);
    }
}
