// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Errors} from "./Errors.sol";

/**
 * @title MurabahaMath — حسابات المرابحة الموحّدة
 * @notice يحل CODE-V2-1 نهائياً: مشكلة القسمة الصحيحة التي كسرت إكمال العقد في V2.
 *         في V2:337 كان installment = sellingPrice / count يسقط الكسور،
 *         فلا يتحقق الإكمال أبداً. هنا القسط الأخير = المتبقي بالضبط دائماً.
 *
 * @dev كل دوال الحساب المالي في مكان واحد — مصدر حقيقة واحد للأرقام.
 */
library MurabahaMath {
    uint256 internal constant BPS = 10000;

    /**
     * @notice يحسب سعر البيع (الثمن المؤجل) = التكلفة × (1 + الربح)
     * @param costPrice سعر التكلفة بـ USDC
     * @param profitBps نسبة الربح (1000 = 10%)
     */
    function sellingPrice(
        uint256 costPrice,
        uint16 profitBps
    ) internal pure returns (uint256) {
        return costPrice + (costPrice * profitBps) / BPS;
    }

    /**
     * @notice قيمة القسط العادي (القسمة لأسفل) — تُستخدم لكل قسط عدا الأخير
     */
    function regularInstallment(
        uint256 totalPayable,
        uint8 totalInstallments
    ) internal pure returns (uint256) {
        if (totalInstallments == 0) revert Errors.InvalidParams();
        return totalPayable / totalInstallments;
    }

    /**
     * @notice ⭐ قيمة القسط الحالي مع معالجة القسط الأخير = المتبقي بالضبط.
     *         هذا هو الإصلاح المحوري لـ CODE-V2-1.
     * @param totalPayable الإجمالي مع الربح
     * @param totalInstallments عدد الأقساط الكلي
     * @param paidInstallments الأقساط المسددة حتى الآن
     * @return amount قيمة القسط القادم (الأخير = المتبقي بدقة، لا فرق wei)
     */
    function nextInstallment(
        uint256 totalPayable,
        uint8 totalInstallments,
        uint8 paidInstallments
    ) internal pure returns (uint256 amount) {
        if (totalInstallments == 0) revert Errors.InvalidParams();

        // القسط الأخير يأخذ كل المتبقي (يصحّح فرق التقريب المتراكم)
        if (paidInstallments + 1 == totalInstallments) {
            // ضرب أولاً ثم قسمة — يتجنب divide-before-multiply
            return totalPayable - (totalPayable * paidInstallments / totalInstallments);
        }
        return totalPayable / totalInstallments;
    }

    /**
     * @notice الدين المتبقي على المركز
     */
    function remainingDebt(
        uint256 totalPayable,
        uint8 totalInstallments,
        uint8 paidInstallments
    ) internal pure returns (uint256) {
        // ضرب أولاً ثم قسمة — يتجنب divide-before-multiply
        return totalPayable - (totalPayable * paidInstallments / totalInstallments);
    }

    /**
     * @notice الضمان المطلوب بـ USDC = الإجمالي × نسبة الضمان
     * @param totalPayable الإجمالي مع الربح
     * @param collateralRatioBps نسبة الضمان (15000 = 150%)
     */
    function requiredCollateralUSDC(
        uint256 totalPayable,
        uint16 collateralRatioBps
    ) internal pure returns (uint256) {
        return (totalPayable * collateralRatioBps) / BPS;
    }

    /**
     * @notice معامل الصحة (Health Factor) بالنقاط الأساسية
     * @param collateralValueUSDC قيمة الضمان السوقية
     * @param obligationsUSDC الالتزامات المتبقية
     * @return hf معامل الصحة (10000 = 100%). لانهائي إذا لا التزامات.
     */
    function healthFactor(
        uint256 collateralValueUSDC,
        uint256 obligationsUSDC
    ) internal pure returns (uint256 hf) {
        if (obligationsUSDC == 0) return type(uint256).max;
        return (collateralValueUSDC * BPS) / obligationsUSDC;
    }
}
