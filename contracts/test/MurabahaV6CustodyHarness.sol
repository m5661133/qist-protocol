// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MurabahaV6} from "../MurabahaV6.sol";

/// @notice ⚠️ للاختبار فقط — لا يُنشر أبداً. يفرض خللاً محاسبياً (#14/#14b) وسحباً يتجاوز
///         المحاسبة (#15) لاختبار accountingFault وقاطع I2. بلا صلاحيات عمداً.
contract MurabahaV6CustodyHarness is MurabahaV6 {
    function forceOfferCustody(address t, uint256 v) external { offerCustody[t] = v; }
    function forceCollateralCustody(address t, uint256 v) external { collateralCustody[t] = v; }
    function forceDrain(address t, address to, uint256 amount) external {
        if (t == address(0)) { (bool ok,) = payable(to).call{value: amount}(""); require(ok); }
        else IERC20(t).transfer(to, amount);
    }
}
