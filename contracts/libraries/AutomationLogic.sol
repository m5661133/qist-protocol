// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MurabahaMath} from "./MurabahaMath.sol";
import {Offer, Position} from "./MurabahaTypes.sol";

/// @dev واجهة الاستدعاء الذاتي — address(this) هو الـProxy لأن المكتبة تُنفَّذ بـdelegatecall
interface IMurabahaSelf {
    function isLiquidatable(uint256 positionId) external view returns (bool, string memory);
    function quotePrice(address token) external view returns (uint256);
}

/**
 * @title AutomationLogic — فحص الأتمتة (Build 22)
 * @notice مكتبة **خارجية مربوطة، قراءة فقط**: MurabahaV6.checkUpkeep و_canAutoPay منقولتان
 *         حرفياً (GPT-13 وM-01 كما هما) لتقليص حجم العقد. لا تكتب تخزيناً ولا تحوّل أموالاً.
 *         AUTO_PAY_FEE_BPS مصدره هنا — العقد يعرّف ثابته منه.
 */
library AutomationLogic {
    uint16 internal constant AUTO_PAY_FEE_BPS = 30; // 0.3% إضافية على كل قسط تلقائي

    function check(
        mapping(uint256 => Position) storage positions,
        mapping(uint256 => Offer) storage offers,
        uint256[] storage activeIds
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 len = activeIds.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 pid = activeIds[i];
            Position storage p = positions[pid];
            // GPT-13: تسعير مركزٍ واحد قد يرفض (مغذٍّ متقادم/Sequencer) — كان يُسقط الجولة
            // كلها فتتوقف أتمتة كل المراكز السليمة. نعزله ونتخطّى المركز: لا يُقترَح
            // للتنفيذ (وإلا تكرّر فشله في performUpkeep وحجب الطابور)، والتصفية الفعلية
            // ما زالت ترفض السعر القديم في كل مسار. يُلتقَط حين يعود مغذّيه.
            bool liq;
            try IMurabahaSelf(address(this)).isLiquidatable(pid) returns (bool l, string memory) {
                liq = l;
            } catch {
                continue;
            }
            // FB-60: التصفية التلقائية فقط إذا فعّلها البائع
            // GPT-13 (المتبقي): فرع التأخّر في isLiquidatable لا يقرأ السعر، لكن التسوية
            // (_settleByCollateral) تقرأ سعر الضمان. لا نقترح ما يتعذّر تنفيذه — وإلا فشل
            // في performUpkeep وأُعيد اقتراحه كل جولة فتجمّد الطابور. يُلتقَط حين يعود السعر.
            if (liq && offers[p.offerId].autoLiquidateEnabled) {
                try IMurabahaSelf(address(this)).quotePrice(p.collateralToken) returns (uint256) {
                    return (true, abi.encode(pid));
                } catch {
                    continue;
                }
            }
            // FB-60: الدفع التلقائي فقط إذا فعّله المشتري
            // Build 18 (M-01): + شرط قابلية التحصيل — مركز برصيد/سماحية ناقصة يُتخطّى
            // بدل أن يحتلّ رأس الطابور ويحجب أتمتة بقية المراكز حتى GRACE.
            // المتخطّى: يُدفع يدوياً، أو يصبح قابلاً للتصفية بعد GRACE فيلتقطه الفرع الأول.
            if (!liq && p.autoPayEnabled && block.timestamp >= p.nextDueDate && _canAutoPay(p))
                return (true, abi.encode(pid));
        }
        return (false, bytes(""));
    }

    /// @dev Build 18 (M-01): هل يمكن تحصيل القسط التلقائي فعلاً؟ (رصيد + سماحية المشتري)
    function _canAutoPay(Position storage p) private view returns (bool) {
        uint256 amount = MurabahaMath.nextInstallment(p.totalPayable, p.totalInstallments, p.paidInstallments);
        uint256 total  = amount + (amount * AUTO_PAY_FEE_BPS) / MurabahaMath.BPS;
        IERC20 pay = IERC20(p.paymentToken);
        return pay.balanceOf(p.buyer) >= total
            && pay.allowance(p.buyer, address(this)) >= total;
    }
}
