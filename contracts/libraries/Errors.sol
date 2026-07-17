// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Errors — مكتبة الأخطاء الموحدة
 * @notice كل الأخطاء المشتركة بين الإصدارات في مكان واحد.
 * @dev يحل CODE-DUP: نفس الأخطاء كانت مكررة في V3:36 و V4:26 و V5:28.
 *      تُستورد هكذا: `import {Errors} from "./libraries/Errors.sol";`
 *      وتُرفع هكذا:   `revert Errors.ZeroAmount();`
 */
library Errors {
    // ── المدخلات ──────────────────────────────
    error ZeroAmount();
    error InvalidParams();
    error CollateralNotAccepted();
    error RenounceOwnershipDisabled();
    error EffectiveProfitTooLow();

    // ── الصلاحيات ─────────────────────────────
    error NotBuyer();
    error NotSeller();
    error NotAuthorized();

    // ── الحالة ────────────────────────────────
    error OfferNotActive();
    error PositionNotActive();
    error AlreadyBought();

    // ── السيولة والضمان ───────────────────────
    error InsufficientLiquidity(uint256 available, uint256 required);
    error InsufficientCollateral(uint256 provided, uint256 required);
    error ExceedsFreeLiquidity(uint256 requested, uint256 free);
    error ExceedsFreeCollateral(uint256 requested, uint256 free);
    error HealthFactorTooLow(uint256 current, uint256 minimum); // CODE-V5-2

    // ── الأقساط والتصفية ──────────────────────
    error InstallmentNotDue(uint256 nextDue);
    error NoDefault();
    error NotLiquidatable();
    /// @dev المشتري اختار عدد أقساط خارج نطاق البائع
    error InvalidInstallments(uint8 selected, uint8 min, uint8 max);
    /// @dev الكمية المطلوبة أقل من الحد الأدنى المسموح في العرض
    error BelowMinPurchase(uint256 amount, uint256 minimum);

    // ── الأسعار والتحويل ──────────────────────
    error StalePrice();
    error TransferFailed();
    error SlippageExceeded(uint256 quoted, uint256 current);
    /// @dev H2: L2 Sequencer متوقّف — لا يُعتمد على السعر
    error SequencerDown();
    /// @dev H2: L2 Sequencer عاد للتوّ — مهلة التعافي لم تنتهِ بعد
    error SequencerGracePeriodNotOver();

    // ── التوكنات المتعددة ──────────────────────
    /// @dev التوكن غير مسجّل في العقد
    error TokenNotSupported();
    /// @dev العملية تتطلب ستابل كوين لكن التوكن ليس كذلك
    error NotStablecoin();
    /// @dev العملية تتطلب أصلاً متقلباً (غير ستابل) لكن التوكن ستابل كوين
    error IsStablecoin();

    // ── FB-31: حماية ضد Self-Buy ──────────────
    /// @notice البائع لا يستطيع شراء عرضه الخاص (مخالفة شرعية + ثغرة أمنية)
    /// @dev تُرمى في `_buy()` عندما يكون msg.sender == offer.seller — FB-31, 2026-06-04
    error SelfBuyNotAllowed();

    // ── FB-32: الدوال العامة للتدخل اليدوي ────
    /// @notice المركز ليس قابلاً للتصفية بعد (الضمان كافٍ والقسط ضمن المهلة)
    error NotLiquidatableYet();
    /// @notice مهلة السماح بعد استحقاق القسط لم تنتهِ بعد
    error GracePeriodNotExpired();
    /// @notice القسط القادم لم يحن وقته بعد
    error NotDueYet();

    // ── Build 18: M-03 ────────────────────────
    /// @notice سحب الطوارئ يتجاوز ETH الحر (الرصيد − التزامات pull المعلّقة)
    error InsufficientFreeETH();

    // ── Build 19: تقييد صلاحية المالك على أموال المستخدمين ────────────────
    /// @notice محاولة سحب أصل حقيقي (ETH/USDC/cbBTC أو أي رمز مدعوم) — أموال المستخدمين محميّة
    error CannotWithdrawUserAsset();
}
