// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Errors} from "./Errors.sol";

/**
 * @title TransferLib — تحويلات ETH آمنة بنمط Pull
 * @notice يحل CODE-V5-4: في V5:597 كان تحويل ETH بنمط push
 *         `(bool ok,) = to.call{value}(...)` — لو المستلم عقد يرفض ETH،
 *         تفشل _liquidate/_complete للأبد ويُقفل المركز وسيولة البائع.
 *
 * @dev الحل: نمط pull-over-push. بدل الدفع المباشر، نسجّل المستحق في
 *      mapping ويسحبه المستخدم بنفسه عبر withdraw. لا يمكن لمستلم خبيث
 *      أن يعطّل منطق التصفية الحرج.
 *
 * الاستخدام في العقد:
 *   using TransferLib for TransferLib.Ledger;
 *   TransferLib.Ledger private _pending;
 *   _pending.credit(user, amount);        // بدل push داخل التصفية
 *   ... ثم دالة عامة: _pending.withdraw(); // المستخدم يسحب
 */
library TransferLib {
    struct Ledger {
        mapping(address => uint256) balances;
    }

    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    /**
     * @notice يسجّل مبلغاً مستحقاً لحساب (لا يحوّل فوراً — نمط pull)
     */
    function credit(Ledger storage self, address account, uint256 amount) internal {
        if (amount == 0) return;
        self.balances[account] += amount;
        emit Credited(account, amount);
    }

    /**
     * @notice المستخدم يسحب رصيده المستحق (آمن من إعادة الدخول مع CEI)
     * @dev يجب أن يُستدعى من دالة عليها nonReentrant في العقد المضيف.
     */
    function withdraw(Ledger storage self, address to) internal returns (uint256 amount) {
        amount = self.balances[to];
        if (amount == 0) revert Errors.ZeroAmount();

        // Effects قبل Interactions (CEI)
        self.balances[to] = 0;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert Errors.TransferFailed();

        emit Withdrawn(to, amount);
    }

    function balanceOf(Ledger storage self, address account) internal view returns (uint256) {
        return self.balances[account];
    }
}
