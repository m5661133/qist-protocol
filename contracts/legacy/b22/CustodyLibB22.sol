// SPDX-License-Identifier: MIT
// ⚠️ نسخة مرجعية لـBuild 22 الحي (git tag build22-deployed-src) — للتحقق من التخزين والكود فقط، لا تُنشر.
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Errors} from "../../libraries/Errors.sol";
import {PricingLib} from "../../libraries/PricingLib.sol";
import {TokenConfig, Offer, Position, OfferState} from "../../libraries/MurabahaTypes.sol";

/**
 * @title CustodyLib — منطق السقف الإجمالي للعهدة (Build 22)
 * @notice مكتبة **خارجية مربوطة** (external, linked): تُنفَّذ بـdelegatecall في سياق الـProxy
 *         فتقرأ وتكتب تخزينه عبر المؤشّرات الممرَّرة. نُقلت إلى هنا لأن العقد تجاوز حدّ
 *         24,576 بايت (docs/global-cap-design.md §7). لا تملك تخزيناً ولا selfdestruct.
 * @dev    التسعير عبر PricingLib — نفس المصدر الذي يستعمله العقد وBuyLogic.
 */
library CustodyLibB22 {
    event AccountingFaultDetected(address indexed token, uint256 had, uint256 removed);
    event CustodyReconciled(address indexed token, uint256 oldOffer, uint256 oldCollateral, uint256 newOffer, uint256 newCollateral);

    /// @notice الإجمالي بالـUSDC: A + B + C (أو A وحدها)
    function exposure(
        mapping(address => uint256) storage offerC,
        mapping(address => uint256) storage colC,
        address[] storage tokens,
        mapping(address => TokenConfig) storage cfgs,
        uint256 pendingETH,
        address sequencer,
        bool offersOnly
    ) external view returns (uint256 total) {
        uint256 n = tokens.length;
        for (uint256 i; i < n; ++i) {
            address t = tokens[i];
            uint256 units = offersOnly ? offerC[t] : _owed(offerC, colC, t, pendingETH);
            if (units == 0) continue; // لا يُقرأ سعر رمز بلا عهدة
            total += PricingLib.value(cfgs[t], sequencer, units); // Build 22: مصدر تسعير واحد
        }
    }

    /// @notice I2 لكل رمز بعهدة: الرصيد الفعلي ≥ المُدان به
    function checkSolvency(
        mapping(address => uint256) storage offerC,
        mapping(address => uint256) storage colC,
        address[] storage tokens,
        uint256 pendingETH
    ) external view {
        uint256 n = tokens.length;
        for (uint256 i; i < n; ++i) {
            address t = tokens[i];
            uint256 owed = _owed(offerC, colC, t, pendingETH);
            if (owed == 0) continue;
            uint256 bal = _balanceOf(t);
            if (bal < owed) revert Errors.CustodyInsolvent(t, bal, owed);
        }
    }

    /// @notice رصيد غير متتبَّع (تبرّعات/إرسال خاطئ) — للمراقبة فقط
    function untracked(
        mapping(address => uint256) storage offerC,
        mapping(address => uint256) storage colC,
        address token,
        uint256 pendingETH
    ) external view returns (uint256) {
        uint256 bal = _balanceOf(token);
        uint256 owed = _owed(offerC, colC, token, pendingETH);
        return bal > owed ? bal - owed : 0;
    }

    /// @notice مصالحة بلقطة **كاملة** مطابقة لـtokens حرفياً، وI2 لكل رمز قبل الكتابة
    function reconcile(
        mapping(address => uint256) storage offerC,
        mapping(address => uint256) storage colC,
        address[] storage tokens,
        uint256 pendingETH,
        address[] calldata inTokens,
        uint256[] calldata offerValues,
        uint256[] calldata collateralValues
    ) external {
        uint256 n = tokens.length;
        if (inTokens.length != n || offerValues.length != n || collateralValues.length != n)
            revert Errors.InvalidParams();                                   // فارغة/ناقصة/زائدة
        for (uint256 i; i < n; ++i) {
            address t = tokens[i];
            if (inTokens[i] != t) revert Errors.InvalidParams();              // ترتيب/تكرار/غريب
            uint256 owed = offerValues[i] + collateralValues[i] + (t == address(0) ? pendingETH : 0);
            uint256 bal = _balanceOf(t);
            if (bal < owed) revert Errors.CustodyInsolvent(t, bal, owed);     // I2 — تُرفض كلها
            emit CustodyReconciled(t, offerC[t], colC[t], offerValues[i], collateralValues[i]);
            offerC[t] = offerValues[i];
            colC[t] = collateralValues[i];
        }
    }

    /// @notice ترحيل Build 22: يبني العدّادات من التخزين ويرفض tokens المكرّرة
    function migrate(
        mapping(address => uint256) storage offerC,
        mapping(address => uint256) storage colC,
        address[] storage tokens,
        mapping(uint256 => Offer) storage offers,
        uint256 nextOfferId,
        mapping(uint256 => Position) storage positions,
        uint256[] storage activeIds
    ) external {
        uint256 n = tokens.length;
        for (uint256 i = 1; i < n; ++i)
            for (uint256 j; j < i; ++j)
                if (tokens[i] == tokens[j]) revert Errors.InvalidParams();
        for (uint256 id = 1; id < nextOfferId; ++id) {
            Offer storage o = offers[id];
            if (o.state == OfferState.ACTIVE) offerC[o.saleToken] += o.saleAmount;
        }
        uint256 np = activeIds.length;
        for (uint256 i; i < np; ++i) {
            Position storage p = positions[activeIds[i]];
            colC[p.collateralToken] += p.collateralAmount;
        }
    }

    function _owed(
        mapping(address => uint256) storage offerC,
        mapping(address => uint256) storage colC,
        address t,
        uint256 pendingETH
    ) private view returns (uint256) {
        return offerC[t] + colC[t] + (t == address(0) ? pendingETH : 0);
    }

    function _balanceOf(address t) private view returns (uint256) {
        return t == address(0) ? address(this).balance : IERC20(t).balanceOf(address(this));
    }
}
