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
import {PriceLib} from "./libraries/PriceLib.sol";

/**
 * @title BtcEscrowMurabaha v2 — سوق بيع بيتكوين حقيقي بالأجل، برهن بيتكوين حقيقي
 * @author Qist / قسط
 *
 * @notice طبقة Base لسوق **ثنائي الاتجاه**: البائع ينشر عرض بيع، أو المشتري ينشر طلب شراء،
 *         ومن أعجبه عرض الآخر قبِله. البيع بثمن مؤجّل بالـ USDC (تكلفة + هامش ربح ثابت)،
 *         مضموناً ببيتكوين **حقيقي** يرهنه المشتري في Multisig 2-of-3 على شبكة Bitcoin.
 *         لا WBTC/cbBTC ولا جسور.
 *
 *  الصورة الشرعية:
 *    1. بيع بالأجل: البائع يبيع بيتكويناً، والثمن مؤجّل أقساطاً بالـ USDC.
 *    2. **المشتري يقبض المبيع فعلاً** في عنوانه الخاص — البائع يرسله مباشرة، لا عبر خزنة.
 *    3. المشتري يرهن بيتكويناً **منفصلاً** لضمان السداد، محجوزاً في 2-of-3.
 *    4. بعد سداد آخر قسط يُفَكّ الرهن ويعود للمشتري.
 *
 *  الخطوات ثلاث، ومعاملات بيتكوين ثلاث:
 *    (١) إنشاء العرض/الطلب على Base   (٢) القبول ثم إيداع الرهن   (٣) تسليم المبيع للمشتري
 *    معاملات L1: إيداع الرهن · تسليم المبيع · فكّ الرهن. وهو الحد الأدنى الممكن.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  المبدأ الحاكم: هذا العقد **لا يملك ولا يحرّك أي ساتوشي**. لا يحتجز بيتكوين ولا يوقّع
 *  معاملة Bitcoin. دوره: (1) سجل شروط البيع، (2) محرّك أقساط USDC، (3) آلة حالات شفّافة
 *  تحسب LTV من سعر Chainlink وتصدر «إذن» التصفية/الإفراج. حركة البيتكوين تحدث على L1،
 *  وتُبلَّغ للعقد عبر «شهادات» من خدمة qist-btc (دور attestor). حتى لو زُوّرت شهادة، لا
 *  يتحرّك بيتكوين حقيقي — لا يتحرّك إلا بتوقيعين حقيقيين في الخزنة.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  دور قسط: **حَكَم فقط.** مفتاحها في الخزنة معطَّل في المسار السليم — فكّ الرهن بعد السداد
 *  يوقّعه البائع والمشتري وحدهما. تتدخّل قسط فقط إن أخلّ أحد الطرفين أو اختفى.
 *
 *  قرارات التصميم:
 *   BE-01: عقد منفصل تماماً عن MurabahaV6 (cbBTC مغلّف) — نموذجا حفظ مختلفان.
 *   BE-02: التسعير عبر Chainlink BTC/USD على Base + فحص L2 Sequencer (PriceLib).
 *   BE-03: البيتكوين حقيقي (8 خانات) يُسجَّل فقط — merchandiseSats للمبيع، collateralSats للرهن.
 *   BE-05: شرط الإفراج عن الرهن يُقرأ أونشين (REPAID)، لا يقرّره مشغّل بشري.
 *   BE-06: التصفية جزئية بحدّ الدين+الرسوم، والفائض يعود للمشتري.
 *   BE-07: المالك لا يمسّ USDC المستخدمين — emergencyWithdraw يحظره (على غرار D-056).
 *   BE-08: لا يستلم المشتري USDC إطلاقاً (بيع لا قرض) — الـUSDC يتدفّق من المشتري للبائع فقط.
 *   BE-09 (v2): المبيع **لا يمرّ بالخزنة**. يذهب من محفظة البائع لعنوان المشتري مباشرة،
 *               فيسقط «التوقيع المنسّق الذرّي» وتنزل معاملات L1 من ٤ إلى ٣.
 *   BE-10 (v2): سوق ثنائي الاتجاه — createSellOffer و createBuyRequest يلتقيان عند accept.
 *   BE-11 (v2): مفتاح المُنشئ العام يُنشر مع العرض، فيستطيع القابل اشتقاق عنوان الخزنة
 *               وإيداع الرهن فوراً بلا جولة تفاوض إضافية.
 */
contract BtcEscrowMurabaha is
    Initializable,
    ReentrancyGuard,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using PriceLib for IChainlinkFeed;

    // ═══════════════════════ الثوابت ═══════════════════════

    uint256 internal constant BPS = 10000;
    uint8   internal constant BTC_DECIMALS = 8; // ساتوشي

    /**
     * @notice أقصى LTV عند الإطلاق — 87% (رهن ≥ 1.15× الدين).
     *
     * BE-13: رُفع من 8000 لتصير نسبة الضمان **عرضاً وطلباً**: يختارها الطرفان
     * من هامش 15% إلى 100% فوق الدين، ويسعّر السوق المخاطرة بدل أن يفرضها العقد.
     *
     * ⚠️ الهامش الرقيق مقبول للآجال القصيرة **فقط**. عند 15% يكفي هبوط 8.4%
     * في بتكوين لبلوغ التصفية، واحتمال ذلك ≈ 20% خلال أسبوع و**86% خلال سنة**.
     * فمُنشئ صفقة سنوية بهامش 15% يُصفَّى غالباً قبل السداد. الواجهة تعرض هذا
     * الاحتمال حسب الأجل المختار وتوصي بالهامش المكافئ — تحذيراً لا منعاً.
     */
    uint16 public constant MAX_INITIAL_LTV_BPS     = 8700;
    uint16 public constant MAX_LIQUIDATION_LTV_BPS = 9500; // 95% — أقصى عتبة تصفية

    uint16 public constant MAX_PROFIT_BPS       = 30000;  // 300% — السوق عرض وطلب؛ الحد لتفادي خطأ بشري
    uint8  public constant MAX_INSTALLMENTS     = 120;
    uint32 public constant MIN_PAYMENT_INTERVAL = 1 days;
    /// @dev 4 سنوات (مع يوم كبيسة) — يسمح بالدفعة الواحدة إلى أجل بعيد (قسط واحد = أجل السداد).
    ///      الواجهة قد تعرض خيارات أضيق، لكن العقد لا يمنع ما هو مشروع.
    uint32 public constant MAX_PAYMENT_INTERVAL = 1461 days;
    uint256 public constant GRACE_PERIOD        = 3 days; // مهلة السماح بعد استحقاق القسط
    uint256 public constant DISPUTE_WINDOW      = 2 days; // نافذة النزاع بعد التعثّر المبدئي

    uint16 public constant MAX_PROTOCOL_FEE_BPS = 300; // 3%

    /// @notice مهلة تسليم البائع للمبيع بعد كفاية الرهن — بعدها يُلغي أيّ طرف ويستردّ المشتري رهنه
    uint256 public constant DELIVERY_DEADLINE = 2 days;

    /// @notice طول المفتاح العام المضغوط (33 بايت: بادئة + إحداثي X)
    uint256 internal constant BTC_PUBKEY_LEN = 33;
    /// @notice حدّ أعلى لطول عنوان Bitcoin النصّي (bech32m طويل ≈ 90) — حماية من حشو التخزين
    uint256 internal constant MAX_BTC_ADDRESS_LEN = 100;

    // ═══════════════════════ الحالات (13) ═══════════════════════

    enum DealState {
        OPEN,                  // 0  عرض بيع أو طلب شراء منشور، بانتظار الطرف المقابل
        AWAITING_COLLATERAL,   // 1  قُبِل، بانتظار إيداع المشتري للرهن على L1
        AWAITING_DELIVERY,     // 2  الرهن كافٍ، بانتظار تسليم البائع للمبيع لعنوان المشتري
        ACTIVE,                // 3  سُلّم المبيع، السداد جارٍ
        PAYMENT_OVERDUE,       // 4  قسط تجاوز موعده (ضمن مهلة السماح)
        MARGIN_CALL,           // 5  LTV تجاوز عتبة الإنذار — يلزم تعزيز أو سداد جزئي
        DEFAULT_PENDING,       // 6  انتهت مهلة السماح — تعثّر مبدئي (نافذة نزاع)
        DISPUTED,              // 7  نزاع بانتظار تحكيم قسط
        LIQUIDATION_ELIGIBLE,  // 8  مؤهّلة للتصفية
        LIQUIDATED,            // 9  نُفّذت التصفية على L1
        REPAID,                // 10 سُدّد كامل الثمن — إذن فكّ الرهن
        COLLATERAL_RELEASED,   // 11 فُكّ الرهن وعاد للمشتري على L1
        CANCELLED              // 12 أُلغيت قبل التفعيل
    }

    // ═══════════════════════ الهياكل ═══════════════════════

    /// @notice شروط الصفقة كما يحدّدها مُنشئها (بائعاً كان أو مشترياً).
    struct Terms {
        uint256 cost;                   // تكلفة المبيع بالـ USDC (6 خانات)
        uint16  profitBps;              // هامش ربح المرابحة (ثابت — بيع لا فائدة)
        uint8   totalInstallments;      // 1 = دفعة واحدة
        uint32  paymentInterval;        // الفاصل بين الأقساط (ثوانٍ)
        uint16  marginCallLtvBps;       // عتبة نداء الهامش
        uint16  liquidationLtvBps;      // عتبة التصفية
        uint64  merchandiseSats;        // البيتكوين المبيع (يسلّمه البائع للمشتري)
        uint64  requiredCollateralSats; // الرهن المطلوب من المشتري
    }

    struct Deal {
        // الأطراف — في OPEN أحدهما صفر (الطرف الشاغر)، وغير الصفر هو المُنشئ
        address buyer;                 // المشتري — يرهن، يستلم المبيع، يدفع الأقساط
        address seller;                // البائع — يسلّم المبيع، يستلم الأقساط

        // مالية المرابحة (USDC 6 خانات)
        uint256 cost;
        uint256 totalPayable;          // التكلفة + هامش الربح
        uint256 paidAmount;
        uint16  profitBps;

        // جدول الأقساط
        uint8   totalInstallments;
        uint8   paidInstallments;
        uint32  paymentInterval;
        uint256 nextDueDate;

        // البيتكوين الحقيقي (مُسجَّل فقط — لا يُحتجز هنا)
        uint64  merchandiseSats;       // المبيع المتفق عليه
        uint64  requiredCollateralSats;// الرهن المطلوب
        uint64  collateralSats;        // الرهن المُودَع فعلاً (يشهد به attestor)
        bytes32 escrowDescriptorHash;  // التزام بوصف عنوان خزنة الرهن 2-of-3

        // عتبات المخاطر (نقاط أساسية على قيمة الرهن)
        uint16  marginCallLtvBps;
        uint16  liquidationLtvBps;

        DealState state;
        uint256 deliveryDeadline;      // بعد كفاية الرهن: مهلة تسليم البائع للمبيع

        // مفاتيح وعناوين Bitcoin (لاشتقاق الخزنة وتسليم المبيع)
        bytes  sellerBtcPubkey;        // مفتاح البائع المضغوط (33 بايت)
        bytes  buyerBtcPubkey;         // مفتاح المشتري المضغوط (33 بايت)
        string buyerBtcAddress;        // عنوان استلام المبيع — البائع يرسل إليه مباشرة
    }

    // ═══════════════════════ التخزين ═══════════════════════
    // ⚠️ الترتيب أدناه مطابق حرفياً لـ v1 — لا تُعِد ترتيبه ولا تحذف منه.

    IERC20 public usdc;
    IChainlinkFeed public btcUsdFeed;
    IChainlinkFeed public sequencerFeed;

    address public attestor;           // خدمة qist-btc — تشهد بأحداث L1 (تسجيل فقط)
    address public arbiter;            // محكّم قسط
    address public protocolTreasury;

    uint16 public protocolFeeBps;      // رسوم على كل قسط (تُقتطع للخزينة)

    uint256 public nextDealId;
    mapping(uint256 => Deal) public deals;

    /// BE-12: مفتاح قسط العام (المضغوط) — الطرف الثالث في كل خزنة.
    /// يُخزَّن ليتمكّن العقد من رفض مَن ينتحله. مضاف في نهاية التخزين (خانة من __gap).
    /// ما دام فارغاً لا يُفرَض شيء — فلا تنكسر الصفقات قبل ضبطه.
    bytes public arbiterBtcPubkey;

    uint256[44] private __gap;

    // ═══════════════════════ الأحداث ═══════════════════════

    event SellOfferCreated(uint256 indexed dealId, address indexed seller, uint256 cost, uint256 totalPayable, uint64 merchandiseSats, uint64 requiredCollateralSats);
    event BuyRequestCreated(uint256 indexed dealId, address indexed buyer, uint256 cost, uint256 totalPayable, uint64 merchandiseSats, uint64 requiredCollateralSats);
    event DealAccepted(uint256 indexed dealId, address indexed acceptor, bool acceptorIsBuyer);
    event CollateralConfirmed(uint256 indexed dealId, uint64 sats, bytes32 escrowDescriptorHash, bytes32 indexed depositTxid);
    event CollateralPartial(uint256 indexed dealId, uint64 sats, uint256 ltvBps);
    event CollateralUpdated(uint256 indexed dealId, uint64 newSats, bytes32 indexed txid);
    event MerchandiseDelivered(uint256 indexed dealId, uint64 sats, bytes32 indexed deliveryTxid);
    event InstallmentPaid(uint256 indexed dealId, uint8 installmentNo, uint256 gross, uint256 fee, uint256 toSeller);
    event StateChanged(uint256 indexed dealId, DealState indexed from, DealState indexed to);
    event MarginCallRaised(uint256 indexed dealId, uint256 ltvBps);
    event DisputeRaised(uint256 indexed dealId, address indexed by);
    event DisputeResolved(uint256 indexed dealId, DealState outcome);
    event Liquidated(uint256 indexed dealId, uint256 debtCoveredUSDC, uint64 satsToSeller, uint64 surplusSatsToBuyer, bytes32 indexed liquidationTxid);
    event CollateralReleased(uint256 indexed dealId, bytes32 indexed releaseTxid);
    event DealCancelled(uint256 indexed dealId);
    event ConfigUpdated();

    // ═══════════════════════ الأخطاء ═══════════════════════

    error ZeroAddress();
    error InvalidParams();
    error NotParty();
    error NotAttestor();
    error NotArbiter();
    error BadState(DealState current);
    error ProfitTooHigh();
    error InstallmentsOutOfRange();
    error IntervalOutOfRange();
    error LtvConfigInvalid();
    error FeeTooHigh();
    error MerchandiseTooLittle(uint64 delivered, uint64 required);
    error NothingDue();
    error DeliveryDeadlineNotPassed();
    error CannotWithdrawUserAsset(); // BE-07
    error EthRescueFailed();
    error InvalidPubkey();
    error InvalidBtcAddress();
    error SelfDealNotAllowed();
    error DuplicateBtcPubkey();  // BE-12
    error ArbiterKeyNotAllowed(); // BE-12

    // ═══════════════════════ المُعدِّلات ═══════════════════════

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }
    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }
    modifier inState(uint256 dealId, DealState expected) {
        if (deals[dealId].state != expected) revert BadState(deals[dealId].state);
        _;
    }

    // ═══════════════════════ التهيئة والترقية ═══════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address _usdc,
        address _btcUsdFeed,
        address _sequencerFeed,
        address _attestor,
        address _arbiter,
        address _treasury,
        uint16  _protocolFeeBps
    ) external initializer {
        if (
            _owner == address(0) || _usdc == address(0) || _btcUsdFeed == address(0) ||
            _sequencerFeed == address(0) || _attestor == address(0) || _arbiter == address(0) ||
            _treasury == address(0)
        ) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();

        __Ownable_init(_owner);
        __Pausable_init();

        usdc = IERC20(_usdc);
        btcUsdFeed = IChainlinkFeed(_btcUsdFeed);
        sequencerFeed = IChainlinkFeed(_sequencerFeed);
        attestor = _attestor;
        arbiter = _arbiter;
        protocolTreasury = _treasury;
        protocolFeeBps = _protocolFeeBps;
        nextDealId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ═══════════════════════ إعدادات المالك ═══════════════════════

    function setAttestor(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); attestor = a; emit ConfigUpdated(); }

    /// @notice BE-12: يضبط مفتاح قسط العام على Bitcoin ليرفض العقد مَن ينتحله.
    /// @dev لا يمسّ الصفقات القائمة — الفحص عند الإنشاء والقبول فقط.
    function setArbiterBtcPubkey(bytes calldata k) external onlyOwner {
        _validatePubkey(k);
        arbiterBtcPubkey = k;
        emit ConfigUpdated();
    }
    function setArbiter(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); arbiter = a; emit ConfigUpdated(); }
    function setTreasury(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); protocolTreasury = a; emit ConfigUpdated(); }
    function setProtocolFeeBps(uint16 bps) external onlyOwner { if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh(); protocolFeeBps = bps; emit ConfigUpdated(); }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ═══════════════════════ (1) الإنشاء — الاتجاهان ═══════════════════════

    /**
     * @notice البائع ينشر **عرض بيع**: يبيع `merchandiseSats` بيتكوين بثمن مؤجّل.
     * @dev BE-10/BE-11: يُنشر فوراً (OPEN) بلا خطوة نشر منفصلة، ومعه مفتاح البائع العام
     *      ليشتقّ المشتري عنوان الخزنة لحظة القبول ويودع رهنه بلا جولة إضافية.
     * @param t                شروط الصفقة.
     * @param sellerBtcPubkey  مفتاح البائع العام المضغوط (33 بايت) — أحد مفاتيح خزنة 2-of-3.
     */
    function createSellOffer(Terms calldata t, bytes calldata sellerBtcPubkey)
        external whenNotPaused returns (uint256 dealId)
    {
        _validateTerms(t);
        _validatePubkey(sellerBtcPubkey);
        _rejectArbiterKey(sellerBtcPubkey); // BE-12

        dealId = nextDealId++;
        Deal storage d = deals[dealId];
        _applyTerms(d, t);
        d.seller = msg.sender;
        d.sellerBtcPubkey = sellerBtcPubkey;
        d.state = DealState.OPEN;

        emit SellOfferCreated(dealId, msg.sender, t.cost, d.totalPayable, t.merchandiseSats, t.requiredCollateralSats);
    }

    /**
     * @notice المشتري ينشر **طلب شراء**: يطلب `merchandiseSats` بيتكوين بثمن مؤجّل.
     * @param t                 شروط الصفقة.
     * @param buyerBtcPubkey    مفتاح المشتري العام المضغوط (33 بايت) — أحد مفاتيح خزنة 2-of-3.
     * @param buyerBtcAddress   عنوان استلام المبيع — البائع يرسل إليه مباشرة (BE-09).
     */
    function createBuyRequest(Terms calldata t, bytes calldata buyerBtcPubkey, string calldata buyerBtcAddress)
        external whenNotPaused returns (uint256 dealId)
    {
        _validateTerms(t);
        _validatePubkey(buyerBtcPubkey);
        _rejectArbiterKey(buyerBtcPubkey); // BE-12
        _validateBtcAddress(buyerBtcAddress);

        dealId = nextDealId++;
        Deal storage d = deals[dealId];
        _applyTerms(d, t);
        d.buyer = msg.sender;
        d.buyerBtcPubkey = buyerBtcPubkey;
        d.buyerBtcAddress = buyerBtcAddress;
        d.state = DealState.OPEN;

        emit BuyRequestCreated(dealId, msg.sender, t.cost, d.totalPayable, t.merchandiseSats, t.requiredCollateralSats);
    }

    // ═══════════════════════ (2) القبول ═══════════════════════

    /**
     * @notice الطرف المقابل يقبل بالشروط المنشورة كما هي — يملأ الطرف الشاغر.
     * @dev إن كان الشاغر هو المشتري لزم عنوان استلام؛ وإن كان البائع أُهمِل العنوان.
     *      بعد القبول تصير الخزنة قابلة للاشتقاق (مفتاحا الطرفين + قسط) فيودع المشتري رهنه.
     * @param btcPubkey  مفتاح القابل العام المضغوط (33 بايت).
     * @param btcAddress عنوان استلام المبيع — مطلوب إن كان القابل مشترياً، ويُهمَل إن كان بائعاً.
     */
    function accept(uint256 dealId, bytes calldata btcPubkey, string calldata btcAddress)
        external whenNotPaused inState(dealId, DealState.OPEN)
    {
        _validatePubkey(btcPubkey);
        _rejectArbiterKey(btcPubkey);
        Deal storage d = deals[dealId];

        bool acceptorIsBuyer = (d.buyer == address(0));
        if (acceptorIsBuyer) {
            if (msg.sender == d.seller) revert SelfDealNotAllowed();
            // BE-12: مفتاح مطابق لمفتاح الطرف الآخر يجعل الخزنة صورية —
            //        خانتان لمفتاح واحد ⇒ حاملُه يوقّع مرتين ويسحب منفرداً.
            //        SelfDealNotAllowed يحرس عنوان Base وحده، ومحفظة Bitcoin منفصلة عنه.
            if (keccak256(btcPubkey) == keccak256(d.sellerBtcPubkey)) revert DuplicateBtcPubkey();
            _validateBtcAddress(btcAddress);
            d.buyer = msg.sender;
            d.buyerBtcPubkey = btcPubkey;
            d.buyerBtcAddress = btcAddress;
        } else {
            if (msg.sender == d.buyer) revert SelfDealNotAllowed();
            if (keccak256(btcPubkey) == keccak256(d.buyerBtcPubkey)) revert DuplicateBtcPubkey();
            d.seller = msg.sender;
            d.sellerBtcPubkey = btcPubkey;
        }

        _setState(dealId, DealState.AWAITING_COLLATERAL);
        emit DealAccepted(dealId, msg.sender, acceptorIsBuyer);
    }

    // ═══════════════════════ (3) شهادة الرهن ═══════════════════════

    /**
     * @notice تشهد qist-btc بأن المشتري أودع الرهن في خزنة 2-of-3 على L1.
     * @dev لا تتقدّم الصفقة حتى يبلغ الرهن المطلوب **و** يكون LTV الابتدائي ضمن الحد.
     *      إن نقص، تبقى في AWAITING_COLLATERAL ويودع المشتري المزيد ثم يُعاد الاستدعاء.
     */
    function confirmCollateral(uint256 dealId, uint64 sats, bytes32 escrowDescriptorHash, bytes32 depositTxid)
        external whenNotPaused onlyAttestor inState(dealId, DealState.AWAITING_COLLATERAL)
    {
        if (sats == 0 || escrowDescriptorHash == bytes32(0)) revert InvalidParams();
        Deal storage d = deals[dealId];

        d.collateralSats = sats;
        d.escrowDescriptorHash = escrowDescriptorHash;
        emit CollateralConfirmed(dealId, sats, escrowDescriptorHash, depositTxid);

        if (sats < d.requiredCollateralSats) {
            emit CollateralPartial(dealId, sats, _currentLtvBps(d));
            return;
        }
        uint256 ltv = _currentLtvBps(d);
        if (ltv > MAX_INITIAL_LTV_BPS) {
            emit CollateralPartial(dealId, sats, ltv);
            return;
        }

        d.deliveryDeadline = block.timestamp + DELIVERY_DEADLINE;
        _setState(dealId, DealState.AWAITING_DELIVERY);
    }

    // ═══════════════════════ (4) شهادة تسليم المبيع ═══════════════════════

    /**
     * @notice تشهد qist-btc بأن البائع أرسل المبيع إلى **عنوان المشتري مباشرة** على L1.
     * @dev BE-09: لا خزنة للمبيع ولا توقيع منسّق — المشتري قبض المبيع فعلاً، فيبدأ جدول الأقساط.
     * @param sats  الساتوشي المُسلَّم فعلياً؛ يُرفض ما نقص عن المتفق عليه.
     */
    function confirmDelivery(uint256 dealId, uint64 sats, bytes32 deliveryTxid)
        external whenNotPaused onlyAttestor inState(dealId, DealState.AWAITING_DELIVERY)
    {
        Deal storage d = deals[dealId];
        if (sats < d.merchandiseSats) revert MerchandiseTooLittle(sats, d.merchandiseSats);

        d.nextDueDate = block.timestamp + d.paymentInterval;
        _setState(dealId, DealState.ACTIVE);
        emit MerchandiseDelivered(dealId, sats, deliveryTxid);
    }

    // ═══════════════════════ (5) السداد (أقساط USDC من المشتري للبائع) ═══════════════════════

    /**
     * @notice سداد القسط بالـ USDC. يُوجَّه للبائع بعد اقتطاع رسوم البروتوكول.
     * @dev أي طرف يدفع نيابةً عن المشتري. آخر قسط يسدّد الرصيد المتبقي كاملاً.
     */
    function payInstallment(uint256 dealId) external nonReentrant whenNotPaused {
        Deal storage d = deals[dealId];
        if (
            d.state != DealState.ACTIVE &&
            d.state != DealState.PAYMENT_OVERDUE &&
            d.state != DealState.MARGIN_CALL &&
            d.state != DealState.DEFAULT_PENDING
        ) revert BadState(d.state);

        uint256 due = _installmentDue(d);
        if (due == 0) revert NothingDue();

        uint256 fee = (due * protocolFeeBps) / BPS;
        uint256 toSeller = due - fee;

        d.paidAmount += due;
        d.paidInstallments += 1;

        emit InstallmentPaid(dealId, d.paidInstallments, due, fee, toSeller);

        if (d.paidInstallments >= d.totalInstallments || d.paidAmount >= d.totalPayable) {
            _setState(dealId, DealState.REPAID); // BE-05: إذن فكّ الرهن
        } else {
            d.nextDueDate = block.timestamp + d.paymentInterval;
            if (d.state != DealState.ACTIVE) _setState(dealId, DealState.ACTIVE);
        }

        usdc.safeTransferFrom(msg.sender, address(this), due);
        if (fee > 0) usdc.safeTransfer(protocolTreasury, fee);
        usdc.safeTransfer(d.seller, toSeller);
    }

    // ═══════════════════════ (6) الصحة والأتمتة وتحديث الرهن ═══════════════════════

    function previewHealth(uint256 dealId) external view returns (uint256 ltvBps, DealState suggested) {
        Deal storage d = deals[dealId];
        ltvBps = _currentLtvBps(d);
        suggested = _healthState(d, ltvBps);
    }

    /// @notice يطبّق انتقال الحالة بناءً على الوقت والسعر (Chainlink Automation أو أي طرف). لا يحرّك أموالاً.
    function poke(uint256 dealId) external whenNotPaused {
        Deal storage d = deals[dealId];
        uint256 ltvBps = _currentLtvBps(d);
        DealState target = _healthState(d, ltvBps);
        if (target != d.state) {
            if (target == DealState.MARGIN_CALL) emit MarginCallRaised(dealId, ltvBps);
            _setState(dealId, target);
        }
    }

    /// @notice تحديث كمية الرهن بعد تعزيز/سحب جزئي مسموح على L1 (attestor يعكس واقع L1).
    function updateCollateral(uint256 dealId, uint64 newSats, bytes32 txid) external whenNotPaused onlyAttestor {
        Deal storage d = deals[dealId];
        if (
            d.state != DealState.ACTIVE && d.state != DealState.PAYMENT_OVERDUE &&
            d.state != DealState.MARGIN_CALL && d.state != DealState.DEFAULT_PENDING
        ) revert BadState(d.state);
        d.collateralSats = newSats;
        emit CollateralUpdated(dealId, newSats, txid);

        uint256 ltvBps = _currentLtvBps(d);
        DealState target = _healthState(d, ltvBps);
        if (target != d.state) _setState(dealId, target);
    }

    // ═══════════════════════ (7) النزاع ═══════════════════════

    function raiseDispute(uint256 dealId) external whenNotPaused {
        Deal storage d = deals[dealId];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
        if (
            d.state != DealState.ACTIVE && d.state != DealState.PAYMENT_OVERDUE &&
            d.state != DealState.MARGIN_CALL && d.state != DealState.DEFAULT_PENDING &&
            d.state != DealState.LIQUIDATION_ELIGIBLE
        ) revert BadState(d.state);
        _setState(dealId, DealState.DISPUTED);
        emit DisputeRaised(dealId, msg.sender);
    }

    /// @notice محكّم قسط يحسم النزاع بنقل الصفقة لحالة نهائية مسموحة. لا يحرّك BTC (على L1 بـ 2-of-3).
    function resolveDispute(uint256 dealId, DealState outcome)
        external whenNotPaused onlyArbiter inState(dealId, DealState.DISPUTED)
    {
        if (
            outcome != DealState.LIQUIDATION_ELIGIBLE &&
            outcome != DealState.REPAID &&
            outcome != DealState.ACTIVE &&
            outcome != DealState.CANCELLED
        ) revert InvalidParams();
        _setState(dealId, outcome);
        emit DisputeResolved(dealId, outcome);
    }

    // ═══════════════════════ (8) شهادات نتائج L1 (تصفية / فكّ الرهن) ═══════════════════════

    /**
     * @notice تشهد qist-btc بأن التصفية نُفّذت على L1 بعد توقيع البائع + قسط (2-of-3).
     * @dev BE-06: تصفية جزئية — satsToSeller بحدّ الدين+الرسوم، والفائض للمشتري.
     */
    function confirmLiquidation(
        uint256 dealId,
        uint256 debtCoveredUSDC,
        uint64 satsToSeller,
        uint64 surplusSatsToBuyer,
        bytes32 liquidationTxid
    ) external whenNotPaused onlyAttestor inState(dealId, DealState.LIQUIDATION_ELIGIBLE) {
        _setState(dealId, DealState.LIQUIDATED);
        emit Liquidated(dealId, debtCoveredUSDC, satsToSeller, surplusSatsToBuyer, liquidationTxid);
    }

    /// @notice تشهد qist-btc بأن الرهن فُكّ وعاد للمشتري على L1 (بعد سداد كامل أو إلغاء).
    function confirmCollateralReleased(uint256 dealId, bytes32 releaseTxid)
        external whenNotPaused onlyAttestor
    {
        Deal storage d = deals[dealId];
        if (d.state != DealState.REPAID && d.state != DealState.CANCELLED) revert BadState(d.state);
        _setState(dealId, DealState.COLLATERAL_RELEASED);
        emit CollateralReleased(dealId, releaseTxid);
    }

    // ═══════════════════════ (9) الإلغاء ═══════════════════════

    /**
     * @notice الإلغاء قبل التفعيل. استرجاع الرهن يتم على L1 بتوقيع المشتري + قسط، ثم يشهد attestor.
     * @dev OPEN: المُنشئ وحده · AWAITING_COLLATERAL: أيّ طرف ·
     *      AWAITING_DELIVERY: أيّ طرف بعد انقضاء مهلة التسليم (حماية المشتري من بائع لم يسلّم).
     */
    function cancel(uint256 dealId) external whenNotPaused {
        Deal storage d = deals[dealId];
        DealState s = d.state;

        if (s == DealState.OPEN) {
            // المُنشئ هو الطرف غير الصفر
            address creator = d.seller != address(0) ? d.seller : d.buyer;
            if (msg.sender != creator) revert NotParty();
        } else if (s == DealState.AWAITING_COLLATERAL) {
            if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
        } else if (s == DealState.AWAITING_DELIVERY) {
            if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
            if (block.timestamp < d.deliveryDeadline) revert DeliveryDeadlineNotPassed();
        } else {
            revert BadState(s);
        }

        _setState(dealId, DealState.CANCELLED);
        emit DealCancelled(dealId);
    }

    // ═══════════════════════ الطوارئ (BE-07) ═══════════════════════

    function emergencyWithdraw(address token) external onlyOwner whenPaused {
        if (token == address(usdc)) revert CannotWithdrawUserAsset();
        if (token == address(0)) {
            // العقد بلا receive/payable فلا يستقبل ETH عادةً؛ هذا لاسترجاع ETH مُرسَل قسراً فقط
            uint256 ethBal = address(this).balance;
            if (ethBal > 0) {
                (bool ok, ) = protocolTreasury.call{value: ethBal}("");
                if (!ok) revert EthRescueFailed();
            }
            return;
        }
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(protocolTreasury, bal);
    }

    // ═══════════════════════ الدوال الداخلية ═══════════════════════

    function _validateTerms(Terms calldata t) internal pure {
        if (t.cost == 0 || t.merchandiseSats == 0 || t.requiredCollateralSats == 0) revert InvalidParams();
        if (t.profitBps > MAX_PROFIT_BPS) revert ProfitTooHigh();
        if (t.totalInstallments == 0 || t.totalInstallments > MAX_INSTALLMENTS) revert InstallmentsOutOfRange();
        if (t.paymentInterval < MIN_PAYMENT_INTERVAL || t.paymentInterval > MAX_PAYMENT_INTERVAL) revert IntervalOutOfRange();
        if (
            t.marginCallLtvBps == 0 ||
            t.marginCallLtvBps >= t.liquidationLtvBps ||
            t.liquidationLtvBps > MAX_LIQUIDATION_LTV_BPS
        ) revert LtvConfigInvalid();
    }

    function _applyTerms(Deal storage d, Terms calldata t) internal {
        d.cost = t.cost;
        d.totalPayable = (t.cost * (BPS + t.profitBps)) / BPS;
        d.profitBps = t.profitBps;
        d.totalInstallments = t.totalInstallments;
        d.paymentInterval = t.paymentInterval;
        d.marginCallLtvBps = t.marginCallLtvBps;
        d.liquidationLtvBps = t.liquidationLtvBps;
        d.merchandiseSats = t.merchandiseSats;
        d.requiredCollateralSats = t.requiredCollateralSats;
    }

    /// @dev مفتاح عام مضغوط: 33 بايت وبادئة 0x02 أو 0x03. لا يتحقّق العقد من كونه نقطة صحيحة
    ///      على المنحنى — ذلك في qist-btc قبل اشتقاق الخزنة (العقد لا يحرّك بيتكويناً).
    function _validatePubkey(bytes calldata pk) internal pure {
        if (pk.length != BTC_PUBKEY_LEN) revert InvalidPubkey();
        if (pk[0] != 0x02 && pk[0] != 0x03) revert InvalidPubkey();
    }

    /**
     * @dev BE-12: يمنع انتحال مفتاح قسط.
     *
     * الخزنة `sortedmulti(2, مشترٍ, بائع, قسط)`. لو ساوى طرفٌ مفتاحَه بمفتاح قسط
     * صارت خانتان من الثلاث لمفتاح واحد، ويكفي حاملَه توقيعان — أي أن **قسط
     * وحدها تُخرج الرهن**. ذلك حيازة (custody) صريحة تناقض أساس المنتج.
     * لا يُفرَض ما لم يُضبط المفتاح، فلا تنكسر صفقات ما قبل الضبط.
     */
    function _rejectArbiterKey(bytes calldata pk) internal view {
        if (arbiterBtcPubkey.length == 0) return;
        if (keccak256(pk) == keccak256(arbiterBtcPubkey)) revert ArbiterKeyNotAllowed();
    }

    /// @dev طول معقول فقط. صحّة bech32 تُفحص في التطبيق وفي qist-btc قبل البثّ.
    function _validateBtcAddress(string calldata addr) internal pure {
        uint256 len = bytes(addr).length;
        if (len == 0 || len > MAX_BTC_ADDRESS_LEN) revert InvalidBtcAddress();
    }

    function _setState(uint256 dealId, DealState to) internal {
        DealState from = deals[dealId].state;
        deals[dealId].state = to;
        emit StateChanged(dealId, from, to);
    }

    function _installmentDue(Deal storage d) internal view returns (uint256) {
        uint256 remaining = d.totalPayable - d.paidAmount;
        if (remaining == 0) return 0;
        if (d.paidInstallments + 1 >= d.totalInstallments) return remaining;
        uint256 per = d.totalPayable / d.totalInstallments;
        return per > remaining ? remaining : per;
    }

    /// @notice LTV = الدين المتبقّي ÷ قيمة الرهن (نقاط أساسية). يفحص L2 Sequencer قبل قراءة السعر.
    /// @dev المبيع خرج لملك المشتري ولا يدخل في الضمان — الرهن وحده هو المحسوب.
    function _currentLtvBps(Deal storage d) internal view returns (uint256) {
        if (d.collateralSats == 0) return type(uint256).max;
        sequencerFeed.requireSequencerUp();
        uint256 price = btcUsdFeed.priceUSDC();
        uint256 collateralValueUSDC = PriceLib.assetToUSDC(uint256(d.collateralSats), price, BTC_DECIMALS);
        if (collateralValueUSDC == 0) return type(uint256).max;
        uint256 debt = d.totalPayable - d.paidAmount;
        return (debt * BPS) / collateralValueUSDC;
    }

    /// @notice الحالة الصحية المقترحة (منطق نقي). أولوية: تصفية سعرية ثم تعثّر زمني ثم إنذار ثم تأخّر.
    function _healthState(Deal storage d, uint256 ltvBps) internal view returns (DealState) {
        DealState s = d.state;
        if (
            s != DealState.ACTIVE && s != DealState.PAYMENT_OVERDUE &&
            s != DealState.MARGIN_CALL && s != DealState.DEFAULT_PENDING
        ) return s;

        bool overdue = block.timestamp > d.nextDueDate;
        bool graceExpired = block.timestamp > d.nextDueDate + GRACE_PERIOD;
        bool disputeWindowExpired = block.timestamp > d.nextDueDate + GRACE_PERIOD + DISPUTE_WINDOW;

        if (ltvBps >= d.liquidationLtvBps) return DealState.LIQUIDATION_ELIGIBLE;       // تصفية سعرية فورية
        if (disputeWindowExpired) return DealState.LIQUIDATION_ELIGIBLE;                // تعثّر زمني بعد النافذة
        if (graceExpired) return DealState.DEFAULT_PENDING;                             // تعثّر مبدئي
        if (ltvBps >= d.marginCallLtvBps) return DealState.MARGIN_CALL;                 // نداء هامش
        if (overdue) return DealState.PAYMENT_OVERDUE;                                  // تأخّر ضمن المهلة
        return DealState.ACTIVE;
    }

    // ═══════════════════════ قراءات مساعدة ═══════════════════════

    function getDeal(uint256 dealId) external view returns (Deal memory) { return deals[dealId]; }
    function installmentDue(uint256 dealId) external view returns (uint256) { return _installmentDue(deals[dealId]); }

    /// @notice هل الصفقة عرض بيع (أنشأها بائع)؟ يُستخدم في السوق للتصنيف.
    function isSellOffer(uint256 dealId) external view returns (bool) {
        Deal storage d = deals[dealId];
        return d.state == DealState.OPEN && d.seller != address(0);
    }
}
