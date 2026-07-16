// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title QistTimelock — مؤقّت حوكمة قسط (48 ساعة)
 * @notice يقف بين الـ Safe 2-of-3 وملكية MurabahaV6:
 *
 *   Safe ──proposer/executor/canceller──► QistTimelock ──owner──► MurabahaV6 (Proxy)
 *
 *   كل أمر إداري (ترقية/رسوم/خزائن/unpause/emergencyWithdraw) يمرّ بمرحلتين:
 *   schedule (يُعلَن على السلسلة) → انتظار minDelay → execute.
 *   خلال المهلة يرى الجميع العملية المعلّقة على Basescan — ولو كانت خبيثة
 *   (Safe مخترق) يستطيع المستخدمون الخروج، والـ Safe (canceller) يلغيها.
 *
 * @dev استثناء الطوارئ: pause() على MurabahaV6 لا يمرّ من هنا —
 *      الحارس (guardian = Safe) يستدعيها مباشرة وفورياً (Build 18, M-03).
 *
 *      admin = address(0) ← لا مدير خارق؛ الأدوار تُدار حصراً عبر Timelock نفسه.
 */
contract QistTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
