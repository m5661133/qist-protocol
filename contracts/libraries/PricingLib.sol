// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IChainlinkFeed} from "../interfaces/IChainlinkFeed.sol";
import {Errors} from "./Errors.sol";
import {PriceLib} from "./PriceLib.sol";
import {TokenConfig} from "./MurabahaTypes.sol";

/**
 * @title PricingLib — مصدر واحد لتسعير الرموز (Build 22)
 * @notice دوال **داخلية** تُدمَج في كل من يستعملها (MurabahaV6 وCustodyLib وBuyLogic) — بدل
 *         ثلاث نسخ منفصلة كانت قابلة للتباعد. السلوك منقول حرفياً من MurabahaV6 قبل Build 22:
 *         يفحص **التسجيل** لا `active` (GPT-01) · الستابل 1:1 · فحص L2 Sequencer · رفض السعر القديم.
 */
library PricingLib {
    /// @dev سُجِّل يوماً؟ (الستابل بعلمه، وغيره بمغذّيه) — لا يتأثّر بإطفاء active
    function isRegistered(TokenConfig memory cfg) internal pure returns (bool) {
        return cfg.isStablecoin || cfg.chainlinkFeed != address(0);
    }

    /// @dev سعر وحدة بالـUSDC (6 dec). الستابل = 1e6.
    function price(TokenConfig memory cfg, address sequencer) internal view returns (uint256) {
        if (!isRegistered(cfg)) revert Errors.TokenNotSupported();
        if (cfg.isStablecoin) return 1e6;
        if (sequencer != address(0)) PriceLib.requireSequencerUp(IChainlinkFeed(sequencer));
        return PriceLib.priceUSDC(IChainlinkFeed(cfg.chainlinkFeed));
    }

    /// @dev قيمة كمية بالـUSDC (6 dec). الستابل 1:1.
    function value(TokenConfig memory cfg, address sequencer, uint256 amount) internal view returns (uint256) {
        if (!isRegistered(cfg)) revert Errors.TokenNotSupported();
        if (cfg.isStablecoin) return amount;
        if (sequencer != address(0)) PriceLib.requireSequencerUp(IChainlinkFeed(sequencer));
        uint256 p = PriceLib.priceUSDC(IChainlinkFeed(cfg.chainlinkFeed));
        return PriceLib.assetToUSDC(amount, p, cfg.decimals);
    }
}
