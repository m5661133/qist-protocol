// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IChainlinkFeed
 * @notice واجهة Chainlink للحصول على سعر ETH/USD و BTC/USD
 */
interface IChainlinkFeed {
    /**
     * @notice يرجع آخر سعر من Chainlink
     * @return roundId   رقم الجولة
     * @return answer    السعر (8 decimals — مثال: $2000 = 200000000000)
     * @return startedAt وقت بداية الجولة
     * @return updatedAt وقت آخر تحديث
     * @return answeredInRound رقم الجولة التي أجيب فيها
     */
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );

    /// @notice عدد المنازل العشرية للسعر (دائماً 8 في Chainlink)
    function decimals() external view returns (uint8);
}
