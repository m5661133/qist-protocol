// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IChainlinkFeed} from "./interfaces/IChainlinkFeed.sol";
import {Errors} from "./libraries/Errors.sol";
import {PriceLib} from "./libraries/PriceLib.sol";
import {MurabahaMath} from "./libraries/MurabahaMath.sol";
import {TransferLib} from "./libraries/TransferLib.sol";

/**
 * @title MurabahaV6 — مرابحة إسلامية بضمان كريبتو متعدد التوكنات
 * @notice يدعم أي عملة كريبتو متقلبة كضمان وأي ستابل كوين للدفع.
 *         المالك يضيف التوكنات الجديدة عبر addSupportedToken() بدون ترقية العقد.
 *
 * قرارات التصميم:
 *  D-019: Multi-token — address(0)=ETH، أي ERC-20 مدعوم بـ Chainlink feed
 *  D-020: الدفع فقط بالستابل كوين (isStablecoin=true) — الضمان/البيع بغير الستابل فقط
 *  D-021: تسعير الستابل كوين دائماً 1:1 مع USDC (6 decimals) — لا feed مطلوب
 *  D-022: Pause logic — السحب الطارئ للمالك يعمل فقط أثناء الإيقاف، والدفع الدوري محدود بسنة.
 *
 * [D-001..D-018 من النسخة السابقة محفوظة]
 */
contract MurabahaV6 is
    Initializable,
    ReentrancyGuard,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using PriceLib for IChainlinkFeed;
    using TransferLib for TransferLib.Ledger;

    // ═══════════ ثوابت ═══════════

    uint256 internal constant BPS = 10000;
    uint16 public constant MIN_COLLATERAL_RATIO_BPS  = 11000; // 110% — أقل نسبة ضمان يقبلها العقد
    uint16 public constant MAX_COLLATERAL_RATIO_BPS  = 20000; // 200% — أعلى نسبة ضمان مسموحة
    uint16 public constant LIQUIDATION_THRESHOLD_BPS = 10500; // 105%
    uint16 public constant MAX_PROTOCOL_FEE_BPS      = 300;
    uint16 public constant MAX_BROKERAGE_FEE_BPS     = 100;
    uint16 public constant MAX_PROFIT_BPS            = 30000; // 300% — السوق عرض وطلب؛ الحد لتفادي خطأ بشري فقط
    uint16 public constant SLIPPAGE_TOLERANCE_BPS    = 100;   // 1%
    uint32 public constant INTERVAL_MINUTE = 60;
    uint32 public constant INTERVAL_DAY    = 1 days;
    uint32 public constant INTERVAL_MONTH  = 30 days;
    uint32 public constant MIN_PAYMENT_INTERVAL = 60;
    uint32 public constant MAX_PAYMENT_INTERVAL = 365 days;
    uint256 public constant GRACE_PERIOD = 3 days; // 259200s — مهلة الإنتاج (رفق بالمدين قبل التصفية)

    // ═══════════ FB-60: رسوم الأتمتة الاختيارية ═══════════
    uint16 public constant AUTO_PAY_FEE_BPS        = 30;  // 0.3% إضافية على كل قسط تلقائي
    uint16 public constant AUTO_LIQUIDATE_FEE_BPS  = 50;  // 0.5% من حصة البائع عند التصفية التلقائية

    // ═══════════ D-019: إعدادات التوكن ═══════════

    /**
     * @notice إعدادات توكن مدعوم
     * @param chainlinkFeed  مغذّي Chainlink للسعر بالـ USD (address(0) للستابل — سعره 1:1)
     * @param decimals       منازل الكسر (ETH=18، WBTC=8، USDC/USDT=6)
     * @param isStablecoin   true → للدفع فقط | false → للضمان/البيع فقط
     * @param active         هل هو مفعّل حالياً
     */
    struct TokenConfig {
        address chainlinkFeed;
        uint8   decimals;
        bool    isStablecoin;
        bool    active;
    }

    /// @notice address(0) = ETH
    mapping(address => TokenConfig) public tokenConfigs;
    /// @notice قائمة كل التوكنات للاستعراض
    address[] public tokenList;

    // ═══════════ الهياكل ═══════════

    enum OfferState    { ACTIVE, CLOSED }
    enum PositionState { ACTIVE, COMPLETED, LIQUIDATED }

    struct Offer {
        address seller;
        address saleToken;        // أصل البيع — address(0)=ETH
        address collateralToken;  // أصل الضمان — address(0)=ETH
        address paymentToken;     // الستابل كوين للدفع (USDC / USDT / ...)
        uint256 totalAmount;
        uint256 saleAmount;
        uint256 minPurchaseAmount;
        uint16  profitBps;
        uint8   minInstallments;
        uint8   maxInstallments;
        uint32  paymentInterval;
        uint16  collateralRatioBps;
        OfferState state;
        bool    autoLiquidateEnabled; // FB-60: البائع اختار التصفية التلقائية مقابل رسوم
    }

    struct Position {
        uint256 offerId;
        address buyer;
        address saleToken;
        address collateralToken;
        address paymentToken;
        uint256 saleAmount;
        uint256 collateralAmount;
        uint256 totalPayable;
        uint8   totalInstallments;
        uint8   paidInstallments;
        uint32  paymentInterval;
        uint256 nextDueDate;
        PositionState state;
        bool    autoPayEnabled; // FB-60: المشتري اختار الدفع التلقائي مقابل رسوم
    }

    // ═══════════ متغيرات قديمة — محفوظة لتوافق Storage مع الـ Proxy الحالي ═══════════
    // ⚠️ لا تُستخدم في المنطق الجديد — tokenConfigs تحل محلها
    // ⚠️ لا تحذف هذه المتغيرات أبداً — حذفها يكسر تخطيط الـ Storage في الـ Proxy
    IERC20 public usdc;
    IERC20 public wbtc;
    IChainlinkFeed public ethFeed;
    IChainlinkFeed public btcFeed;
    // ════════════════════════════════════════════════════════════════════════

    uint16  public brokerageFeeBps;
    uint16  public protocolFeeBps;
    address public brokerTreasury;
    address public protocolTreasury;
    address public keeper;
    uint256 public nextOfferId;
    uint256 public nextPositionId;

    mapping(uint256 => Offer)     public offers;
    mapping(uint256 => Position)  public positions;
    mapping(address => uint256[]) private _sellerOffers;
    mapping(address => uint256[]) private _buyerPositions;
    TransferLib.Ledger private _pendingETH;

    // ═══════════ H2: فحص L2 Sequencer — مُلحَق أخيراً (آمن للتخزين) ═══════════
    /// @dev مغذّي Chainlink L2 Sequencer Uptime (Base). address(0) = الفحص متخطّى (شبكات بلا sequencer).
    address public sequencerUptimeFeed;

    // ═══════════ M-01: فهرس المراكز النشطة — مُلحَق أخيراً (آمن للتخزين) ═══════════
    // يحلّ CODE-V4-1: checkUpkeep كانت تمرّ على كل المراكز O(n) → DoS تدريجي عند النمو.
    // الآن تمرّ على النشطة فقط. ⚠️ يجب النشر بينما لا مراكز نشطة (الفهرس يبدأ فارغاً).
    /// @dev قائمة معرّفات المراكز النشطة فقط
    uint256[] private _activePositionIds;
    /// @dev positionId → (index+1) داخل _activePositionIds؛ القيمة 0 = «غير موجود»
    mapping(uint256 => uint256) private _activePositionIndex;

    // ═══════════ Build 18: M-03 — مُلحَق أخيراً (آمن للتخزين) ═══════════
    /// @dev إجمالي التزامات ETH المعلّقة للسحب (pull pattern).
    ///      تحقّق on-chain (2026-07-16): صفر أحداث Credited تاريخياً → البدء من 0 دقيق.
    uint256 public totalPendingETH;
    /// @dev حارس الطوارئ — يستطيع pause() فقط. address(0) = معطّل.
    ///      الغاية: بعد نقل الملكية لـ Timelock 48h يبقى إيقاف الطوارئ فورياً عبر الـ Safe.
    address public guardian;

    // ═══════════ Build 20: سقف الإطلاق المحروس — مُلحَق أخيراً (آمن للتخزين) ═══════════
    /// @dev حدّ أقصى لحجم المركز الواحد بالـ USDC (6 dec). 0 = بلا حدّ.
    uint256 public maxPositionValueUSDC;
    /// @dev حدّ أقصى لعدد المراكز النشطة معاً. 0 = بلا حدّ.
    ///      الخسارة القصوى في حادث ≈ maxPositionValueUSDC × maxActivePositions (حدّ محسوب مسبقاً).
    uint256 public maxActivePositions;

    // ═══════════ Events ═══════════

    event TokenAdded(address indexed token, address indexed feed, uint8 decimals, bool isStablecoin);
    event TokenRemoved(address indexed token);
    event SequencerFeedSet(address indexed feed);
    event OfferCreated(uint256 indexed offerId, address indexed seller, address saleToken, address collateralToken, address paymentToken, uint256 amount, uint8 minInstallments, uint8 maxInstallments, uint32 paymentInterval, uint256 minPurchaseAmount);
    event OfferIncreased(uint256 indexed offerId, uint256 added, uint256 newTotal);
    event OfferDecreased(uint256 indexed offerId, uint256 withdrawn, uint256 remaining);
    event OfferCancelled(uint256 indexed offerId);
    event PartialPurchaseCreated(uint256 indexed positionId, uint256 indexed offerId, uint256 purchasedAmount, uint256 remainingInOffer);
    event Purchased(uint256 indexed positionId, uint256 indexed offerId, address indexed buyer, uint256 saleAmount, uint256 collateralAmount, uint256 totalPayable, uint8 selectedInstallments);
    event BrokerageCollected(uint256 indexed offerId, address saleToken, uint256 sellerFee, uint256 buyerFee, uint256 protocolFee, address brokerTreasury, address protocolTreasury);
    event InstallmentPaid(uint256 indexed positionId, uint8 installment, uint256 amount);
    event PositionCompleted(uint256 indexed positionId, uint256 collateralReturned);
    event EarlyRepaidCash(uint256 indexed positionId, uint256 amountPayment);
    event EarlyRepaidCollateral(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund);
    event PositionLiquidated(uint256 indexed positionId, uint256 sellerCollateral, uint256 buyerRefund, string reason);
    event CollateralChanged(uint256 indexed positionId, int256 delta);
    event AutoFeeCollected(uint256 indexed positionId, uint256 autoFee, bool isLiquidationFee); // FB-60
    event KeeperSet(address indexed oldKeeper, address indexed newKeeper);
    event GuardianSet(address indexed oldGuardian, address indexed newGuardian); // Build 18: M-03
    event LaunchCapsSet(uint256 maxPositionValueUSDC, uint256 maxActivePositions); // Build 20
    event UpkeepFailed(uint256 indexed positionId, bytes reason);
    event EmergencyWithdrawn(address indexed token, address indexed to, uint256 amount);
    event ProtocolFeeSet(uint16 oldBps, uint16 newBps);            // شفافية إدارية (Slither/Aderyn L-9)
    event BrokerageFeeSet(uint16 oldBps, uint16 newBps);           // شفافية إدارية (Slither/Aderyn L-9)
    event BrokerTreasurySet(address indexed oldTreasury, address indexed newTreasury);   // شفافية إدارية (L-9)
    event ProtocolTreasurySet(address indexed oldTreasury, address indexed newTreasury); // شفافية إدارية (L-9)

    // ═══════════ Modifiers ═══════════

    modifier onlyKeeperOrOwner() {
        if (msg.sender != keeper && msg.sender != owner()) revert Errors.NotAuthorized();
        _;
    }

    // ═══════════ Constructor / Initializer ═══════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /**
     * @notice يُستدعى مرة واحدة عند نشر الـ Proxy — يحل محل constructor
     * @dev نفس الـ signature السابق للتوافق مع deploy-v6.ts
     */
    function initialize(
        address _usdc, address _wbtc,
        address _ethFeed, address _btcFeed,
        address _brokerTreasury, address _protocolTreasury
    ) public initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();
        if (_usdc == address(0) || _wbtc == address(0) || _ethFeed == address(0) || _btcFeed == address(0)
            || _brokerTreasury == address(0) || _protocolTreasury == address(0)) revert Errors.InvalidParams();

        // حفظ في المتغيرات القديمة للتوافق مع الـ Storage
        usdc     = IERC20(_usdc);
        wbtc     = IERC20(_wbtc);
        ethFeed  = IChainlinkFeed(_ethFeed);
        btcFeed  = IChainlinkFeed(_btcFeed);

        brokerTreasury   = _brokerTreasury;
        protocolTreasury = _protocolTreasury;
        keeper           = msg.sender;
        brokerageFeeBps  = 50;
        protocolFeeBps   = 100;
        nextOfferId      = 1;
        nextPositionId   = 1;

        // D-019: تسجيل التوكنات الافتراضية
        _registerToken(address(0), _ethFeed, 18, false); // ETH
        _registerToken(_wbtc,  _btcFeed,   8,  false); // WBTC
        _registerToken(_usdc,  address(0), 6,  true);  // USDC — ستابل
    }

    /**
     * @notice Upgrade initializer — للـ Proxy الموجود على Sepolia
     * @dev يُستدعى عبر upgradeToAndCall() عند الترقية من نسخة سابقة
     */
    function initializeV2() external reinitializer(2) onlyOwner {
        // ترحيل المتغيرات القديمة إلى tokenConfigs
        if (address(ethFeed) != address(0))
            _registerToken(address(0), address(ethFeed), 18, false);
        if (address(wbtc) != address(0) && address(btcFeed) != address(0))
            _registerToken(address(wbtc), address(btcFeed), 8, false);
        if (address(usdc) != address(0))
            _registerToken(address(usdc), address(0), 6, true);
    }

    /// @dev UUPS: فقط المالك يقدر يرقّي العقد
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice تعطيل التنازل عن الملكية حتى لا تضيع صلاحيات الترقية والطوارئ.
    function renounceOwnership() public view override onlyOwner {
        revert Errors.RenounceOwnershipDisabled();
    }

    receive() external payable {}

    // ═══════════ D-019: إدارة التوكنات ═══════════

    /**
     * @notice يضيف توكناً جديداً (BTC، LINK، AVAX، USDT...)
     * @param token        عنوان التوكن (address(0) = ETH)
     * @param feed         Chainlink USD price feed (address(0) للستابل)
     * @param decimals     منازل الكسر للتوكن
     * @param isStablecoin true → للدفع فقط | false → للضمان/البيع فقط
     */
    function addSupportedToken(
        address token,
        address feed,
        uint8   decimals,
        bool    isStablecoin
    ) external onlyOwner {
        if (tokenConfigs[token].active) revert Errors.InvalidParams(); // مُسجَّل مسبقاً
        if (!isStablecoin && feed == address(0)) revert Errors.InvalidParams(); // الأصل المتقلب يحتاج feed
        if (isStablecoin && decimals != 6) revert Errors.InvalidParams(); // مبالغ الدفع محسوبة بـ 6 decimals
        _registerToken(token, feed, decimals, isStablecoin);
    }

    /// @notice يعطّل توكناً — لا يُحذف بل يُوقَف (العقود القائمة لا تتأثر)
    function removeSupportedToken(address token) external onlyOwner {
        if (!tokenConfigs[token].active) revert Errors.InvalidParams();
        tokenConfigs[token].active = false;
        emit TokenRemoved(token);
    }

    /// @notice كل التوكنات المسجّلة (بما فيها المعطّلة)
    function getSupportedTokens() external view returns (address[] memory) { return tokenList; }

    function _registerToken(address token, address feed, uint8 decimals, bool isStablecoin) internal {
        if (tokenConfigs[token].active) return; // تجاهل التكرار في initialize
        if (isStablecoin && decimals != 6) revert Errors.InvalidParams();
        tokenConfigs[token] = TokenConfig({ chainlinkFeed: feed, decimals: decimals, isStablecoin: isStablecoin, active: true });
        tokenList.push(token);
        emit TokenAdded(token, feed, decimals, isStablecoin);
    }

    // ═══════════ البائع: إنشاء وإدارة العرض ═══════════

    /**
     * @notice البائع يُنشئ عرض بيع
     * @param saleToken        أصل البيع (address(0)=ETH، وإلا ERC-20 مدعوم)
     * @param collateralToken  أصل الضمان المقبول (address(0)=ETH، وإلا ERC-20 مدعوم)
     * @param paymentToken     الستابل كوين للدفع (USDC / USDT / ...)
     * @param saleAmount       الكمية المعروضة (0 إذا كان ETH — يُستخدم msg.value)
     * @param profitBps        نسبة الربح (1000 = 10%)
     * @param minInstallments  الحد الأدنى للأقساط
     * @param maxInstallments  الحد الأقصى للأقساط
     * @param paymentInterval  الفترة بين الأقساط بالثواني
     * @param minPurchaseAmount الحد الأدنى لكل عملية شراء جزئي (0 = لا حد)
     * @param collateralRatioBps نسبة الضمان ≥ 12000 (120%)
     */
    function createOffer(
        address saleToken,
        address collateralToken,
        address paymentToken,
        uint256 saleAmount,
        uint16  profitBps,
        uint8   minInstallments,
        uint8   maxInstallments,
        uint32  paymentInterval,
        uint256 minPurchaseAmount,
        uint16  collateralRatioBps,
        bool    enableAutoLiquidate  // FB-60: true = تصفية تلقائية مقابل 0.5%
    ) external payable whenNotPaused nonReentrant returns (uint256) {
        TokenConfig memory saleCfg = tokenConfigs[saleToken];
        TokenConfig memory colCfg  = tokenConfigs[collateralToken];
        TokenConfig memory payCfg  = tokenConfigs[paymentToken];

        if (!saleCfg.active)        revert Errors.TokenNotSupported();
        if (!colCfg.active)         revert Errors.TokenNotSupported();
        if (!payCfg.active)         revert Errors.TokenNotSupported();
        if (saleCfg.isStablecoin)   revert Errors.IsStablecoin();   // أصل البيع ≠ ستابل
        if (colCfg.isStablecoin)    revert Errors.IsStablecoin();   // الضمان ≠ ستابل
        if (!payCfg.isStablecoin)   revert Errors.NotStablecoin();  // الدفع = ستابل

        uint256 amount;
        if (saleToken == address(0)) {
            if (msg.value == 0) revert Errors.ZeroAmount();
            amount = msg.value;
        } else {
            if (saleAmount == 0) revert Errors.ZeroAmount();
            amount = saleAmount;
            IERC20(saleToken).safeTransferFrom(msg.sender, address(this), amount);
        }

        return _createOffer(saleToken, collateralToken, paymentToken, amount, profitBps,
            minInstallments, maxInstallments, paymentInterval, minPurchaseAmount,
            collateralRatioBps, enableAutoLiquidate);
    }

    function _createOffer(
        address saleToken, address collateralToken, address paymentToken,
        uint256 saleAmount, uint16 profitBps,
        uint8 minInstallments, uint8 maxInstallments,
        uint32 paymentInterval, uint256 minPurchaseAmount,
        uint16 collateralRatioBps, bool enableAutoLiquidate
    ) internal returns (uint256 offerId) {
        if (saleAmount == 0 || maxInstallments == 0 || minInstallments == 0) revert Errors.InvalidParams();
        if (minInstallments > maxInstallments)          revert Errors.InvalidParams();
        if (profitBps > MAX_PROFIT_BPS)                 revert Errors.InvalidParams();
        if (collateralRatioBps < MIN_COLLATERAL_RATIO_BPS) revert Errors.InvalidParams(); // < 110%
        if (collateralRatioBps > MAX_COLLATERAL_RATIO_BPS) revert Errors.InvalidParams(); // > 200%
        if (paymentInterval < MIN_PAYMENT_INTERVAL)     revert Errors.InvalidParams();
        if (paymentInterval > MAX_PAYMENT_INTERVAL)     revert Errors.InvalidParams();

        offerId = nextOfferId++;
        offers[offerId] = Offer({
            seller: msg.sender, saleToken: saleToken, collateralToken: collateralToken,
            paymentToken: paymentToken, totalAmount: saleAmount, saleAmount: saleAmount,
            minPurchaseAmount: minPurchaseAmount, profitBps: profitBps,
            minInstallments: minInstallments, maxInstallments: maxInstallments,
            paymentInterval: paymentInterval, collateralRatioBps: collateralRatioBps,
            state: OfferState.ACTIVE,
            autoLiquidateEnabled: enableAutoLiquidate  // FB-60
        });
        _sellerOffers[msg.sender].push(offerId);
        emit OfferCreated(offerId, msg.sender, saleToken, collateralToken, paymentToken,
            saleAmount, minInstallments, maxInstallments, paymentInterval, minPurchaseAmount);
    }

    /// @notice يزيد كمية العرض
    function increaseOffer(uint256 offerId, uint256 amount) external payable whenNotPaused nonReentrant {
        Offer storage o = offers[offerId];
        if (o.seller != msg.sender)          revert Errors.NotSeller();
        if (o.state != OfferState.ACTIVE)    revert Errors.OfferNotActive();

        uint256 added;
        if (o.saleToken == address(0)) {
            if (msg.value == 0) revert Errors.ZeroAmount();
            added = msg.value;
        } else {
            if (amount == 0) revert Errors.ZeroAmount();
            IERC20(o.saleToken).safeTransferFrom(msg.sender, address(this), amount);
            added = amount;
        }
        o.saleAmount  += added;
        o.totalAmount += added;
        emit OfferIncreased(offerId, added, o.totalAmount);
    }

    function decreaseOffer(uint256 offerId, uint256 amount) external nonReentrant {
        Offer storage o = offers[offerId];
        if (o.seller != msg.sender)          revert Errors.NotSeller();
        if (o.state != OfferState.ACTIVE)    revert Errors.OfferNotActive();
        if (amount == 0 || amount > o.saleAmount) revert Errors.InvalidParams();
        o.saleAmount -= amount;
        if (o.saleAmount == 0) o.state = OfferState.CLOSED;
        _deliverToken(o.saleToken, msg.sender, amount);
        emit OfferDecreased(offerId, amount, o.saleAmount);
    }

    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        if (o.seller != msg.sender)          revert Errors.NotSeller();
        if (o.state != OfferState.ACTIVE)    revert Errors.OfferNotActive();
        uint256 remaining = o.saleAmount;
        o.saleAmount = 0;
        o.state = OfferState.CLOSED;
        if (remaining > 0) _deliverToken(o.saleToken, msg.sender, remaining);
        emit OfferCancelled(offerId);
    }

    // ═══════════ المشتري: الشراء ═══════════

    /**
     * @notice المشتري يشتري من عرض
     * @param offerId              معرّف العرض
     * @param purchaseAmount       الكمية المطلوبة (≤ saleAmount، ≥ minPurchaseAmount)
     * @param collateralAmount     كمية الضمان ERC-20 (0 إذا ETH — يُستخدم msg.value)
     * @param quotedSalePrice      السعر المُقتبَس لحماية الانزلاق (D-018)
     * @param selectedInstallments عدد الأقساط في نطاق [min, max]
     */
    function buy(
        uint256 offerId,
        uint256 purchaseAmount,
        uint256 collateralAmount,
        uint256 quotedSalePrice,
        uint8   selectedInstallments,
        bool    enableAutoPay  // FB-60: true = دفع تلقائي مقابل 0.3%
    ) external payable whenNotPaused nonReentrant returns (uint256) {
        Offer storage o = offers[offerId];

        uint256 colAmount;
        if (o.collateralToken == address(0)) {
            if (msg.value == 0) revert Errors.ZeroAmount();
            colAmount = msg.value;
        } else {
            if (collateralAmount == 0) revert Errors.ZeroAmount();
            IERC20(o.collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
            colAmount = collateralAmount;
        }
        return _buy(offerId, purchaseAmount, colAmount, quotedSalePrice, selectedInstallments, enableAutoPay);
    }

    function _buy(
        uint256 offerId, uint256 purchaseAmount, uint256 collateralAmount,
        uint256 quotedSalePrice, uint8 selectedInstallments, bool enableAutoPay
    ) internal returns (uint256 positionId) {
        Offer storage o = offers[offerId];
        if (o.state != OfferState.ACTIVE)  revert Errors.OfferNotActive();

        // ═══════════ FB-31: حماية ضد Self-Buy (شرعي + أمني) ═══════════
        // المرابحة عقد بين طرفين مختلفين. شراء البائع لنفسه = بيع العينة (محرّم).
        // كما يمنع: التلاعب بـ TVL، ضخّ كاذب، استرداد رسوم البروتوكول بالخطأ.
        if (o.seller == msg.sender) revert Errors.SelfBuyNotAllowed();
        // ════════════════════════════════════════════════════════════

        if (purchaseAmount == 0 || purchaseAmount > o.saleAmount) revert Errors.InvalidParams();
        if (o.minPurchaseAmount > 0 && purchaseAmount < o.minPurchaseAmount)
            revert Errors.BelowMinPurchase(purchaseAmount, o.minPurchaseAmount);
        if (selectedInstallments < o.minInstallments || selectedInstallments > o.maxInstallments)
            revert Errors.InvalidInstallments(selectedInstallments, o.minInstallments, o.maxInstallments);

        // D-018: فحص الانزلاق
        uint256 salePrice = _tokenPriceUSDC(o.saleToken);
        PriceLib.checkSlippage(quotedSalePrice, salePrice, SLIPPAGE_TOLERANCE_BPS);

        // D-012: العمولات من أصل البيع
        uint256 sellerFee      = (purchaseAmount * brokerageFeeBps) / BPS;
        uint256 buyerFee       = (purchaseAmount * brokerageFeeBps) / BPS;
        uint256 protocolFeeAmt = (purchaseAmount * protocolFeeBps)  / BPS;
        uint256 netToBuyer     = purchaseAmount - sellerFee - buyerFee - protocolFeeAmt;

        // الربح التناسبي
        uint16 effectiveProfitBps = uint16(
            (uint256(o.profitBps) * selectedInstallments) / o.maxInstallments
        );
        if (o.profitBps > 0 && effectiveProfitBps == 0) revert Errors.EffectiveProfitTooLow();

        // قيمة الصافي المُستلَم بالـ paymentToken (6 dec)
        uint256 saleValueUSDC = PriceLib.assetToUSDC(
            netToBuyer, salePrice, tokenConfigs[o.saleToken].decimals
        );
        uint256 totalPayable = MurabahaMath.sellingPrice(saleValueUSDC, effectiveProfitBps);

        // D-008: تقييم الضمان
        uint256 collateralValueUSDC = _tokenValueUSDC(o.collateralToken, collateralAmount);
        uint256 requiredValue       = MurabahaMath.requiredCollateralUSDC(totalPayable, o.collateralRatioBps);
        if (collateralValueUSDC < requiredValue)
            revert Errors.InsufficientCollateral(collateralValueUSDC, requiredValue);

        // ── Build 20: سقف الإطلاق المحروس (يحدّ الخسارة القصوى قبل التدقيق المحترف) ──
        if (maxPositionValueUSDC != 0 && totalPayable > maxPositionValueUSDC)
            revert Errors.PositionExceedsCap(totalPayable, maxPositionValueUSDC);
        if (maxActivePositions != 0 && _activePositionIds.length >= maxActivePositions)
            revert Errors.ActivePositionsCapReached(maxActivePositions);

        // ── Effects ──
        o.saleAmount -= purchaseAmount;
        if (o.saleAmount == 0) o.state = OfferState.CLOSED;

        positionId = nextPositionId++;
        positions[positionId] = Position({
            offerId: offerId, buyer: msg.sender,
            saleToken: o.saleToken, collateralToken: o.collateralToken, paymentToken: o.paymentToken,
            saleAmount: netToBuyer, collateralAmount: collateralAmount,
            totalPayable: totalPayable, totalInstallments: selectedInstallments,
            paidInstallments: 0, paymentInterval: o.paymentInterval,
            nextDueDate: block.timestamp + o.paymentInterval, state: PositionState.ACTIVE,
            autoPayEnabled: enableAutoPay  // FB-60
        });
        _buyerPositions[msg.sender].push(positionId);
        _addActivePosition(positionId); // M-01: أضِف للفهرس النشط

        // ── Interactions ──
        if (sellerFee + buyerFee > 0) _deliverToken(o.saleToken, brokerTreasury,  sellerFee + buyerFee);
        if (protocolFeeAmt > 0)       _deliverToken(o.saleToken, protocolTreasury, protocolFeeAmt);
        _deliverToken(o.saleToken, msg.sender, netToBuyer); // push مباشر — msg.sender

        emit BrokerageCollected(offerId, o.saleToken, sellerFee, buyerFee, protocolFeeAmt, brokerTreasury, protocolTreasury);
        emit PartialPurchaseCreated(positionId, offerId, purchaseAmount, o.saleAmount);
        emit Purchased(positionId, offerId, msg.sender, netToBuyer, collateralAmount, totalPayable, selectedInstallments);
    }

    // ═══════════ Health Factor + إدارة الضمان ═══════════

    function healthFactor(uint256 positionId) public view returns (uint256) {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) return type(uint256).max;
        uint256 col  = _tokenValueUSDC(p.collateralToken, p.collateralAmount);
        uint256 debt = MurabahaMath.remainingDebt(p.totalPayable, p.totalInstallments, p.paidInstallments);
        return MurabahaMath.healthFactor(col, debt);
    }

    function withdrawExcessCollateral(uint256 positionId, uint256 amount) external whenNotPaused nonReentrant {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        if (msg.sender != p.buyer)           revert Errors.NotBuyer();
        if (amount == 0 || amount > p.collateralAmount) revert Errors.InvalidParams();
        uint256 newCol = _tokenValueUSDC(p.collateralToken, p.collateralAmount - amount);
        uint256 debt   = MurabahaMath.remainingDebt(p.totalPayable, p.totalInstallments, p.paidInstallments);
        uint256 newHF  = MurabahaMath.healthFactor(newCol, debt);
        if (newHF < MIN_COLLATERAL_RATIO_BPS) revert Errors.HealthFactorTooLow(newHF, MIN_COLLATERAL_RATIO_BPS);
        p.collateralAmount -= amount;
        _deliverToken(p.collateralToken, msg.sender, amount);
        emit CollateralChanged(positionId, -int256(amount));
    }

    /**
     * @notice يضيف ضماناً إضافياً لمركز نشط
     * @param amount كمية الضمان ERC-20 (0 إذا ETH — يُستخدم msg.value)
     */
    function addCollateral(uint256 positionId, uint256 amount) external payable whenNotPaused nonReentrant {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        if (!tokenConfigs[p.collateralToken].active) revert Errors.TokenNotSupported();
        uint256 added;
        if (p.collateralToken == address(0)) {
            if (msg.value == 0) revert Errors.ZeroAmount();
            added = msg.value;
        } else {
            if (amount == 0) revert Errors.ZeroAmount();
            IERC20(p.collateralToken).safeTransferFrom(msg.sender, address(this), amount);
            added = amount;
        }
        p.collateralAmount += added;
        emit CollateralChanged(positionId, int256(added));
    }

    // ═══════════ سداد الأقساط ═══════════

    function payInstallment(uint256 positionId) external whenNotPaused nonReentrant {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        if (msg.sender != p.buyer)           revert Errors.NotBuyer();
        _chargeInstallment(positionId, p.buyer, false); // يدوي: بدون رسوم أتمتة
    }

    function _chargeInstallment(uint256 positionId, address payer, bool withAutoFee) internal {
        Position storage p = positions[positionId];
        Offer storage o    = offers[p.offerId];
        uint256 amount = MurabahaMath.nextInstallment(p.totalPayable, p.totalInstallments, p.paidInstallments);
        uint256 autoFee = withAutoFee ? (amount * AUTO_PAY_FEE_BPS) / BPS : 0;
        address paymentToken = p.paymentToken;
        address collateralToken = p.collateralToken;
        address buyer = p.buyer;
        address seller = o.seller;
        uint8 newPaidInstallments = p.paidInstallments + 1;
        bool completed = newPaidInstallments == p.totalInstallments;
        uint256 col;

        p.paidInstallments = newPaidInstallments;
        p.nextDueDate      += p.paymentInterval;
        if (completed) {
            p.state = PositionState.COMPLETED;
            col = p.collateralAmount;
            p.collateralAmount = 0;
            _removeActivePosition(positionId); // M-01
        }

        IERC20(paymentToken).safeTransferFrom(payer, address(this), amount + autoFee);
        IERC20(paymentToken).safeTransfer(seller, amount);
        if (autoFee > 0) {
            IERC20(paymentToken).safeTransfer(protocolTreasury, autoFee);
            emit AutoFeeCollected(positionId, autoFee, false);
        }
        if (completed) _deliverToken(collateralToken, buyer, col);

        emit InstallmentPaid(positionId, newPaidInstallments, amount);
        if (completed) emit PositionCompleted(positionId, col);
    }

    // ═══════════ الإنهاء المبكر ═══════════

    function earlyRepayCash(uint256 positionId) external whenNotPaused nonReentrant {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        if (msg.sender != p.buyer)           revert Errors.NotBuyer();
        Offer storage o = offers[p.offerId];
        uint256 debt = MurabahaMath.remainingDebt(p.totalPayable, p.totalInstallments, p.paidInstallments);
        IERC20(p.paymentToken).safeTransferFrom(p.buyer, address(this), debt);
        IERC20(p.paymentToken).safeTransfer(o.seller, debt);
        p.paidInstallments = p.totalInstallments;
        p.state = PositionState.COMPLETED;
        _removeActivePosition(positionId); // M-01
        uint256 col = p.collateralAmount;
        p.collateralAmount = 0;
        _deliverToken(p.collateralToken, p.buyer, col);
        emit EarlyRepaidCash(positionId, debt);
        emit PositionCompleted(positionId, col);
    }

    function earlyRepayWithCollateral(uint256 positionId) external whenNotPaused nonReentrant {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        if (msg.sender != p.buyer)           revert Errors.NotBuyer();
        (uint256 s, uint256 r) = _settleByCollateral(positionId, false, false); // يدوي: بدون رسوم
        emit EarlyRepaidCollateral(positionId, s, r);
    }

    // ═══════════ التصفية ═══════════

    function isLiquidatable(uint256 positionId) public view returns (bool, string memory) {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) return (false, "");
        if (block.timestamp > p.nextDueDate + GRACE_PERIOD) return (true, "overdue");
        if (healthFactor(positionId) < LIQUIDATION_THRESHOLD_BPS) return (true, "undercollateralized");
        return (false, "");
    }

    function _settleByCollateral(uint256 positionId, bool isLiquidation, bool withAutoFee) internal returns (uint256 sellerShare, uint256 buyerRefund) {
        Position storage p = positions[positionId];
        Offer storage o    = offers[p.offerId];
        uint256 debt       = MurabahaMath.remainingDebt(p.totalPayable, p.totalInstallments, p.paidInstallments);
        uint256 collateral = p.collateralAmount;
        uint256 price      = _tokenPriceUSDC(p.collateralToken);
        uint256 collateralForDebt = PriceLib.usdcToAsset(debt, price, tokenConfigs[p.collateralToken].decimals);
        sellerShare = collateralForDebt > collateral ? collateral : collateralForDebt;
        buyerRefund = collateral - sellerShare;
        p.collateralAmount = 0;
        p.state = isLiquidation ? PositionState.LIQUIDATED : PositionState.COMPLETED;
        _removeActivePosition(positionId); // M-01

        // FB-60: رسوم التصفية التلقائية (0.5% من حصة البائع تذهب للبروتوكول)
        if (withAutoFee && sellerShare > 0) {
            uint256 autoFee = (sellerShare * AUTO_LIQUIDATE_FEE_BPS) / BPS;
            sellerShare -= autoFee;
            _deliverToken(p.collateralToken, protocolTreasury, autoFee);
            emit AutoFeeCollected(positionId, autoFee, true);
        }

        _deliverToken(p.collateralToken, o.seller,  sellerShare);
        if (buyerRefund > 0) _deliverToken(p.collateralToken, p.buyer, buyerRefund);
    }

    // ═══════════ Chainlink Automation ═══════════

    // ═══════════ M-01: إدارة فهرس المراكز النشطة ═══════════

    /// @dev يُضيف مركزاً للفهرس النشط (عند فتح المركز)
    function _addActivePosition(uint256 positionId) internal {
        _activePositionIds.push(positionId);
        _activePositionIndex[positionId] = _activePositionIds.length; // نخزّن index+1
    }

    /// @dev يُزيل مركزاً من الفهرس النشط بنمط swap-and-pop (عند الاكتمال/التصفية)
    function _removeActivePosition(uint256 positionId) internal {
        uint256 idxPlus1 = _activePositionIndex[positionId];
        if (idxPlus1 == 0) return; // غير موجود — أمان ضد الإزالة المزدوجة
        uint256 idx     = idxPlus1 - 1;
        uint256 lastIdx = _activePositionIds.length - 1;
        if (idx != lastIdx) {
            uint256 lastId               = _activePositionIds[lastIdx];
            _activePositionIds[idx]      = lastId;
            _activePositionIndex[lastId] = idx + 1;
        }
        _activePositionIds.pop();
        _activePositionIndex[positionId] = 0;
    }

    /// @notice عدد المراكز النشطة حالياً (للمراقبة + اختبار سلامة الفهرس)
    function activePositionsCount() external view returns (uint256) {
        return _activePositionIds.length;
    }

    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 len = _activePositionIds.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 pid = _activePositionIds[i];
            Position storage p = positions[pid];
            (bool liq,) = isLiquidatable(pid);
            // FB-60: التصفية التلقائية فقط إذا فعّلها البائع
            if (liq && offers[p.offerId].autoLiquidateEnabled)
                return (true, abi.encode(pid));
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
    function _canAutoPay(Position storage p) internal view returns (bool) {
        uint256 amount = MurabahaMath.nextInstallment(p.totalPayable, p.totalInstallments, p.paidInstallments);
        uint256 total  = amount + (amount * AUTO_PAY_FEE_BPS) / BPS;
        IERC20 pay = IERC20(p.paymentToken);
        return pay.balanceOf(p.buyer) >= total
            && pay.allowance(p.buyer, address(this)) >= total;
    }

    function performUpkeep(bytes calldata performData) external whenNotPaused onlyKeeperOrOwner {
        uint256 positionId = abi.decode(performData, (uint256));
        try this.performUpkeepChecked(performData) {
        } catch (bytes memory reason) {
            emit UpkeepFailed(positionId, reason);
        }
    }

    function performUpkeepChecked(bytes calldata performData) external whenNotPaused nonReentrant {
        if (msg.sender != address(this)) revert Errors.NotAuthorized();
        uint256 positionId = abi.decode(performData, (uint256));
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        (bool liq, string memory reason) = isLiquidatable(positionId);
        if (liq) {
            // FB-60: رسوم التصفية التلقائية مفعّلة فقط إذا اختار البائع ذلك
            bool withLiqFee = offers[p.offerId].autoLiquidateEnabled;
            (uint256 s, uint256 r) = _settleByCollateral(positionId, true, withLiqFee);
            emit PositionLiquidated(positionId, s, r, reason);
            return;
        }
        if (block.timestamp >= p.nextDueDate) {
            // FB-60: رسوم الدفع التلقائي مفعّلة فقط إذا اختار المشتري ذلك
            _chargeInstallment(positionId, p.buyer, p.autoPayEnabled);
        }
    }

    // ═══════════ FB-32: دوال التدخل اليدوي العامة ═══════════
    // الفائدة: لو Chainlink توقّف (نفاد LINK / تأخر RPC / إيقاف الخدمة)،
    // أي طرف يستطيع تشغيل دورة الحياة يدوياً بشرط أن الشروط متحقّقة على السلسلة.

    /// @notice تصفية مركز يدوياً — متاح للجميع لو الشروط متحقّقة
    /// @dev نسخة عامة من منطق performUpkeep للتصفية، مع فحص grace period كحاجز إضافي
    function liquidatePositionPublic(uint256 positionId)
        external nonReentrant whenNotPaused
    {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();

        bool overdue = block.timestamp > p.nextDueDate + GRACE_PERIOD;
        bool undercollateralized = healthFactor(positionId) < LIQUIDATION_THRESHOLD_BPS;
        if (!overdue && !undercollateralized) revert Errors.NotLiquidatableYet();
        string memory reason = overdue ? "overdue" : "undercollateralized";

        (uint256 s, uint256 r) = _settleByCollateral(positionId, true, false); // يدوي: بدون رسوم
        emit PositionLiquidated(positionId, s, r, reason);
    }

    /// @notice سحب قسط مستحق يدوياً — للطوارئ
    /// @dev نفس منطق Chainlink لكن أي طرف يقدر يستدعيها لو القسط مستحق
    function processInstallmentPublic(uint256 positionId)
        external nonReentrant whenNotPaused
    {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) revert Errors.PositionNotActive();
        if (block.timestamp < p.nextDueDate) revert Errors.NotDueYet();
        _chargeInstallment(positionId, p.buyer, false); // يدوي: بدون رسوم
    }

    // ═══════════ أدوات داخلية ═══════════

    /// @dev H2: يفحص L2 Sequencer قبل قراءة السعر (إن كان الـ feed مضبوطاً)
    function _checkSequencer() internal view {
        address seq = sequencerUptimeFeed;
        if (seq != address(0)) PriceLib.requireSequencerUp(IChainlinkFeed(seq));
    }

    /// @dev سعر وحدة من التوكن بـ USDC (6 decimals). الستابل كوين = 1e6.
    function _tokenPriceUSDC(address token) internal view returns (uint256) {
        TokenConfig memory cfg = tokenConfigs[token];
        if (!cfg.active) revert Errors.TokenNotSupported();
        if (cfg.isStablecoin) return 1e6;
        _checkSequencer();
        return IChainlinkFeed(cfg.chainlinkFeed).priceUSDC();
    }

    /// @dev قيمة كمية من التوكن بـ USDC (6 decimals)
    function _tokenValueUSDC(address token, uint256 amount) internal view returns (uint256) {
        TokenConfig memory cfg = tokenConfigs[token];
        if (!cfg.active) revert Errors.TokenNotSupported();
        if (cfg.isStablecoin) return amount; // 1:1 — الستابل
        _checkSequencer();
        uint256 price = IChainlinkFeed(cfg.chainlinkFeed).priceUSDC();
        return PriceLib.assetToUSDC(amount, price, cfg.decimals);
    }

    /// @dev يسلّم أصلاً — push مباشر لـ msg.sender، pull للباقين
    function _deliverToken(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            if (to == msg.sender) {
                (bool ok,) = to.call{value: amount}("");
                if (!ok) { _pendingETH.credit(to, amount); totalPendingETH += amount; } // Build 18: M-03
            } else {
                _pendingETH.credit(to, amount);
                totalPendingETH += amount; // Build 18: M-03
            }
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @notice سحب ETH المعلّق (pull pattern)
    function withdrawETH() external nonReentrant {
        uint256 amount = _pendingETH.withdraw(msg.sender);
        // Build 18 (M-03): إنقاص مُشبَع — يتحمّل أي رصيد قديم سابق للعدّاد دون underflow
        totalPendingETH = totalPendingETH >= amount ? totalPendingETH - amount : 0;
    }

    function pendingETH(address account) external view returns (uint256) {
        return _pendingETH.balanceOf(account);
    }

    // ═══════════ الإدارة ═══════════

    function setProtocolFee(uint16 bps) external onlyOwner {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert Errors.InvalidParams();
        emit ProtocolFeeSet(protocolFeeBps, bps);
        protocolFeeBps = bps;
    }
    function setBrokerageFee(uint16 bps) external onlyOwner {
        if (bps > MAX_BROKERAGE_FEE_BPS) revert Errors.InvalidParams();
        emit BrokerageFeeSet(brokerageFeeBps, bps);
        brokerageFeeBps = bps;
    }
    function setBrokerTreasury(address r) external onlyOwner {
        if (r == address(0)) revert Errors.InvalidParams();
        emit BrokerTreasurySet(brokerTreasury, r);
        brokerTreasury = r;
    }
    function setProtocolTreasury(address r) external onlyOwner {
        if (r == address(0)) revert Errors.InvalidParams();
        emit ProtocolTreasurySet(protocolTreasury, r);
        protocolTreasury = r;
    }
    function setKeeper(address k) external onlyOwner {
        if (k == address(0)) revert Errors.InvalidParams();
        emit KeeperSet(keeper, k);
        keeper = k;
    }
    /// @dev Build 18 (M-03): pause متاح للمالك أو الحارس — بعد Timelock يبقى إيقاف الطوارئ فورياً.
    ///      unpause تبقى onlyOwner (عبر Timelock) — إعادة التشغيل قرار متأنٍّ معلَن، متعمَّد.
    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert Errors.NotAuthorized();
        _pause();
    }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Build 18 (M-03): يضبط حارس الطوارئ (pause فقط). address(0) = تعطيل.
    function setGuardian(address g) external onlyOwner {
        emit GuardianSet(guardian, g);
        guardian = g;
    }

    /// @notice Build 20: يضبط سقوف الإطلاق المحروس. 0 = بلا حدّ.
    /// @param maxPosValueUSDC حدّ أقصى لحجم المركز الواحد (USDC 6 dec)
    /// @param maxActivePos    حدّ أقصى لعدد المراكز النشطة معاً
    function setLaunchCaps(uint256 maxPosValueUSDC, uint256 maxActivePos) external onlyOwner {
        maxPositionValueUSDC = maxPosValueUSDC;
        maxActivePositions   = maxActivePos;
        emit LaunchCapsSet(maxPosValueUSDC, maxActivePos);
    }

    /// @notice H2: يضبط مغذّي L2 Sequencer Uptime (address(0) لتعطيل الفحص على الشبكات بلا sequencer)
    function setSequencerUptimeFeed(address feed) external onlyOwner {
        sequencerUptimeFeed = feed;
        emit SequencerFeedSet(feed);
    }

    /// @dev Build 21 (KRAIT-001): هل سُجِّل هذا الرمز يوماً كأصل مدعوم؟
    ///      tokenList يحتفظ بكل رمز سُجِّل ولا يُحذف منه أبداً (removeSupportedToken يطفئ active فقط) —
    ///      فالفحص دائم ولا يتأثّر بإطفاء الدعم. n صغير جداً (رموز معدودة) + الدالة onlyOwner/whenPaused نادرة.
    function _everRegistered(address token) internal view returns (bool) {
        uint256 len = tokenList.length;
        for (uint256 i = 0; i < len; i++) {
            if (tokenList[i] == token) return true;
        }
        return false;
    }

    /// @notice Build 19: استرجاع الرموز الغريبة فقط (airdrop / إرسال خاطئ لرمز آخر) → محفظة الرسوم.
    /// @dev أموال المستخدمين (ETH + USDC + cbBTC + أي رمز مدعوم) محميّة رياضياً — المالك لا يقدر مسّها إطلاقاً.
    ///      لا وجهة يختارها المالك (ثابتة = protocolTreasury) — [[D-056]].
    ///      Build 21 (KRAIT-001): الحماية الآن لكل رمز سُجِّل يوماً (عبر _everRegistered/tokenList) لا الثلاثة المثبّتة فقط —
    ///      يسدّ ثغرة كان يفتحها اعتماد الحارس على tokenConfigs[token].active المتغيّر: removeSupportedToken(X) ثم emergencyWithdraw(X).
    ///      ⚠️ نتيجة مقصودة: أي ETH يُرسَل خطأً (عبر receive) يُقفَل للأبد — لا يقدر المالك سحبه (أمان > استرجاع نادر).
    function emergencyWithdraw(address token, uint256 amount)
        external
        onlyOwner
        whenPaused
        nonReentrant
    {
        if (amount == 0) revert Errors.InvalidParams();
        if (
            token == address(0) ||
            token == address(usdc) ||
            token == address(wbtc) ||
            _everRegistered(token)
        ) revert Errors.CannotWithdrawUserAsset();

        IERC20(token).safeTransfer(protocolTreasury, amount);
        emit EmergencyWithdrawn(token, protocolTreasury, amount);
    }

    // ═══════════ دوال القراءة ═══════════

    function getOffer(uint256 id)    external view returns (Offer memory)    { return offers[id]; }
    function getPosition(uint256 id) external view returns (Position memory) { return positions[id]; }

    /// @notice سعر توكن بـ USDC — quotePrice(address(0)) لسعر ETH
    function quotePrice(address token) external view returns (uint256) { return _tokenPriceUSDC(token); }

    function getOffersBySeller(address seller) external view returns (uint256[] memory) { return _sellerOffers[seller]; }
    function getPositionsByBuyer(address buyer) external view returns (uint256[] memory) { return _buyerPositions[buyer]; }

    function getRemainingDebt(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) return 0;
        return MurabahaMath.remainingDebt(p.totalPayable, p.totalInstallments, p.paidInstallments);
    }

    function getInstallmentAmount(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        if (p.state != PositionState.ACTIVE) return 0;
        return MurabahaMath.nextInstallment(p.totalPayable, p.totalInstallments, p.paidInstallments);
    }

    function estimatePurchase(
        uint256 offerId,
        uint256 purchaseAmount,
        uint8   selectedInstallments
    ) external view returns (
        uint256 totalPayable,
        uint256 installmentAmount,
        uint256 requiredCollateralUSDC,
        uint16  effectiveProfitBps,
        uint256 netToBuyer
    ) {
        Offer storage o = offers[offerId];
        if (o.state != OfferState.ACTIVE) revert Errors.OfferNotActive();
        if (purchaseAmount == 0 || purchaseAmount > o.saleAmount) revert Errors.InvalidParams();
        if (selectedInstallments < o.minInstallments || selectedInstallments > o.maxInstallments)
            revert Errors.InvalidInstallments(selectedInstallments, o.minInstallments, o.maxInstallments);

        uint256 sellerFee      = (purchaseAmount * brokerageFeeBps) / BPS;
        uint256 buyerFee       = (purchaseAmount * brokerageFeeBps) / BPS;
        uint256 protocolFeeAmt = (purchaseAmount * protocolFeeBps)  / BPS;
        netToBuyer = purchaseAmount - sellerFee - buyerFee - protocolFeeAmt;

        effectiveProfitBps = uint16((uint256(o.profitBps) * selectedInstallments) / o.maxInstallments);
        if (o.profitBps > 0 && effectiveProfitBps == 0) revert Errors.EffectiveProfitTooLow();

        uint256 salePrice    = _tokenPriceUSDC(o.saleToken);
        uint256 saleValueUSDC = PriceLib.assetToUSDC(netToBuyer, salePrice, tokenConfigs[o.saleToken].decimals);
        totalPayable          = MurabahaMath.sellingPrice(saleValueUSDC, effectiveProfitBps);
        installmentAmount     = MurabahaMath.regularInstallment(totalPayable, selectedInstallments);
        requiredCollateralUSDC = MurabahaMath.requiredCollateralUSDC(totalPayable, o.collateralRatioBps);
    }
}
