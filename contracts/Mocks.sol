// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockWBTC is ERC20 {
    constructor() ERC20("Mock WBTC", "WBTC") {}
    function decimals() public pure override returns (uint8) { return 8; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

import {IChainlinkFeed} from "./interfaces/IChainlinkFeed.sol";

/// @dev مغذّي Chainlink مزيف للاختبار المحلي فقط
/// يُرجع block.timestamp دائماً (طازج أبداً) إلا لو استُدعي setStale() صراحةً
contract MockFeed is IChainlinkFeed {
    int256 public answer;
    uint8 public dec;
    bool private _forceStale;
    uint256 private _staleBy;
    constructor(int256 _answer, uint8 _dec) { answer = _answer; dec = _dec; }
    function setAnswer(int256 a) external { answer = a; _forceStale = false; }
    function setStale(uint256 secondsAgo) external { _forceStale = true; _staleBy = secondsAgo; }
    function decimals() external view returns (uint8) { return dec; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 ts = _forceStale ? block.timestamp - _staleBy : block.timestamp;
        return (1, answer, ts, ts, 1);
    }
}

/// @dev Mock L2 Sequencer Uptime Feed للاختبار — answer: 0 = يعمل، 1 = متوقّف
/// startedAt = وقت آخر تغيّر لحالة الـ sequencer (لاختبار مهلة التعافي)
contract MockSequencerFeed is IChainlinkFeed {
    int256  public answer;     // 0 = up, 1 = down
    uint256 public startedAt;
    constructor(int256 _answer, uint256 _startedAt) { answer = _answer; startedAt = _startedAt; }
    function set(int256 _answer, uint256 _startedAt) external { answer = _answer; startedAt = _startedAt; }
    function decimals() external pure returns (uint8) { return 0; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }
}
