// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Errors} from "./Errors.sol";
import {PriceLib} from "./PriceLib.sol";
import {MurabahaMath} from "./MurabahaMath.sol";
import {PricingLib} from "./PricingLib.sol";
import {TokenConfig, Offer, OfferState, Position, PositionState} from "./MurabahaTypes.sol";

/**
 * @title BuyLogic — فحوصات الشراء وحساباته (Build 22)
 * @notice مكتبة **خارجية مربوطة**: تُنفَّذ بـdelegatecall في سياق الـProxy (msg.sender = المشتري).
 *         نُقل إليها الجزء **الحسابي** من MurabahaV6._buy حرفياً وبالترتيب نفسه لأخطائه، لتقليص
 *         حجم العقد (docs/size-analysis.md). `quote` لا تكتب شيئاً؛ `record` تكتب المركز وفهرسيه
 *         فقط (منقولة حرفياً). تحديث العرض وعدّادات العهدة والتحويلات والأحداث باقية في العقد.
 */
library BuyLogic {
    struct Params {
        uint256 purchaseAmount;
        uint256 collateralAmount;
        uint256 quotedSalePrice;
        uint8   selectedInstallments;
        uint16  brokerageFeeBps;
        uint16  protocolFeeBps;
        uint16  slippageToleranceBps;
        uint256 maxPositionValueUSDC;
        uint256 maxActivePositions;
        uint256 activePositions;
        address sequencer;
    }

    struct Quote {
        uint256 sellerFee;
        uint256 buyerFee;
        uint256 protocolFee;
        uint256 netToBuyer;
        uint256 totalPayable;
    }

    function quote(
        Offer storage o,
        mapping(address => TokenConfig) storage cfgs,
        Params memory p
    ) external view returns (Quote memory q) {
        if (o.state != OfferState.ACTIVE)  revert Errors.OfferNotActive();

        // GPT-09: الشراء التزام جديد ⇒ يُحكَم بـ`active` كـ`createOffer`.
        if (!cfgs[o.saleToken].active)       revert Errors.TokenNotSupported();
        if (!cfgs[o.collateralToken].active) revert Errors.TokenNotSupported();
        if (!cfgs[o.paymentToken].active)    revert Errors.TokenNotSupported();

        // FB-31: حماية ضد Self-Buy (شرعي + أمني)
        if (o.seller == msg.sender) revert Errors.SelfBuyNotAllowed();

        if (p.purchaseAmount == 0 || p.purchaseAmount > o.saleAmount) revert Errors.InvalidParams();
        if (o.minPurchaseAmount > 0 && p.purchaseAmount < o.minPurchaseAmount)
            revert Errors.BelowMinPurchase(p.purchaseAmount, o.minPurchaseAmount);
        if (p.selectedInstallments < o.minInstallments || p.selectedInstallments > o.maxInstallments)
            revert Errors.InvalidInstallments(p.selectedInstallments, o.minInstallments, o.maxInstallments);

        // D-018: فحص الانزلاق
        TokenConfig memory saleCfg = cfgs[o.saleToken];
        uint256 salePrice = PricingLib.price(saleCfg, p.sequencer);
        PriceLib.checkSlippage(p.quotedSalePrice, salePrice, p.slippageToleranceBps);

        // D-012: العمولات من أصل البيع
        q.sellerFee   = (p.purchaseAmount * p.brokerageFeeBps) / MurabahaMath.BPS;
        q.buyerFee    = (p.purchaseAmount * p.brokerageFeeBps) / MurabahaMath.BPS;
        q.protocolFee = (p.purchaseAmount * p.protocolFeeBps)  / MurabahaMath.BPS;
        q.netToBuyer  = p.purchaseAmount - q.sellerFee - q.buyerFee - q.protocolFee;

        // الربح التناسبي
        uint16 effectiveProfitBps = uint16(
            (uint256(o.profitBps) * p.selectedInstallments) / o.maxInstallments
        );
        if (o.profitBps > 0 && effectiveProfitBps == 0) revert Errors.EffectiveProfitTooLow();

        // قيمة الصافي المُستلَم بالـ paymentToken (6 dec)
        uint256 saleValueUSDC = PriceLib.assetToUSDC(q.netToBuyer, salePrice, saleCfg.decimals);
        q.totalPayable = MurabahaMath.sellingPrice(saleValueUSDC, effectiveProfitBps);

        // D-008: تقييم الضمان
        uint256 collateralValueUSDC = PricingLib.value(cfgs[o.collateralToken], p.sequencer, p.collateralAmount);
        uint256 requiredValue       = MurabahaMath.requiredCollateralUSDC(q.totalPayable, o.collateralRatioBps);
        if (collateralValueUSDC < requiredValue)
            revert Errors.InsufficientCollateral(collateralValueUSDC, requiredValue);

        // Build 20: سقف الإطلاق المحروس
        if (p.maxPositionValueUSDC != 0 && q.totalPayable > p.maxPositionValueUSDC)
            revert Errors.PositionExceedsCap(q.totalPayable, p.maxPositionValueUSDC);
        if (p.maxActivePositions != 0 && p.activePositions >= p.maxActivePositions)
            revert Errors.ActivePositionsCapReached(p.maxActivePositions);
    }

    /// @notice كتابة المركز الجديد + فهرس المشتري + فهرس المراكز النشطة (M-01) — منقولة حرفياً
    function record(
        mapping(uint256 => Position) storage positions,
        mapping(address => uint256[]) storage buyerPositions,
        uint256[] storage activeIds,
        mapping(uint256 => uint256) storage activeIndex,
        Offer storage o,
        uint256 positionId,
        uint256 offerId,
        uint256 netToBuyer,
        uint256 collateralAmount,
        uint256 totalPayable,
        uint8   selectedInstallments,
        bool    enableAutoPay
    ) external {
        positions[positionId] = Position({
            offerId: offerId, buyer: msg.sender,
            saleToken: o.saleToken, collateralToken: o.collateralToken, paymentToken: o.paymentToken,
            saleAmount: netToBuyer, collateralAmount: collateralAmount,
            totalPayable: totalPayable, totalInstallments: selectedInstallments,
            paidInstallments: 0, paymentInterval: o.paymentInterval,
            nextDueDate: block.timestamp + o.paymentInterval, state: PositionState.ACTIVE,
            autoPayEnabled: enableAutoPay  // FB-60
        });
        buyerPositions[msg.sender].push(positionId);
        // M-01: أضِف للفهرس النشط (كان MurabahaV6._addActivePosition)
        activeIds.push(positionId);
        activeIndex[positionId] = activeIds.length; // نخزّن index+1
    }

    struct Estimate {
        uint256 totalPayable;
        uint256 installmentAmount;
        uint256 requiredCollateralUSDC;
        uint16  effectiveProfitBps;
        uint256 netToBuyer;
    }

    /// @notice تقدير الشراء (قراءة فقط) — MurabahaV6.estimatePurchase منقولة حرفياً
    function estimate(
        Offer storage o,
        mapping(address => TokenConfig) storage cfgs,
        uint256 purchaseAmount,
        uint8   selectedInstallments,
        uint16  brokerageFeeBps,
        uint16  protocolFeeBps,
        address sequencer
    ) external view returns (Estimate memory e) {
        if (o.state != OfferState.ACTIVE) revert Errors.OfferNotActive();
        if (purchaseAmount == 0 || purchaseAmount > o.saleAmount) revert Errors.InvalidParams();
        if (selectedInstallments < o.minInstallments || selectedInstallments > o.maxInstallments)
            revert Errors.InvalidInstallments(selectedInstallments, o.minInstallments, o.maxInstallments);

        uint256 sellerFee      = (purchaseAmount * brokerageFeeBps) / MurabahaMath.BPS;
        uint256 buyerFee       = (purchaseAmount * brokerageFeeBps) / MurabahaMath.BPS;
        uint256 protocolFeeAmt = (purchaseAmount * protocolFeeBps)  / MurabahaMath.BPS;
        e.netToBuyer = purchaseAmount - sellerFee - buyerFee - protocolFeeAmt;

        e.effectiveProfitBps = uint16((uint256(o.profitBps) * selectedInstallments) / o.maxInstallments);
        if (o.profitBps > 0 && e.effectiveProfitBps == 0) revert Errors.EffectiveProfitTooLow();

        TokenConfig memory saleCfg = cfgs[o.saleToken];
        uint256 salePrice     = PricingLib.price(saleCfg, sequencer);
        uint256 saleValueUSDC = PriceLib.assetToUSDC(e.netToBuyer, salePrice, saleCfg.decimals);
        e.totalPayable           = MurabahaMath.sellingPrice(saleValueUSDC, e.effectiveProfitBps);
        e.installmentAmount      = MurabahaMath.regularInstallment(e.totalPayable, selectedInstallments);
        e.requiredCollateralUSDC = MurabahaMath.requiredCollateralUSDC(e.totalPayable, o.collateralRatioBps);
    }
}
