# ملاحظات Fidesium المجانية في عرضها (Procur3، 2026-10-05)

المصدر: عرض Fidesium على طلب Build 22. المدقّق: Abraham Polishchuk (CTO). لم تُصلَح بعد.

1. **مراكز الغبار تعطّل buy() للجميع (DoS).** `maxActivePositions = 5` حياً، و`minPurchaseAmount = 0` في العرض #22، ولا يوجد شرط `totalPayable > 0`. شراء 1 wei بضمان 1 wei ينتج `totalPayable = 0`، وهذا المركز لا يُصفّى إلا بعد تأخّره عن موعد السداد. خمسة منها تكفي لإرجاع `ActivePositionsCapReached(5)` لكل مشترٍ. قالوا إنهم جرّبوه على fork.
   - تحقّق محلي: `BuyLogic.sol:55-92` لا يفحص totalPayable > 0. الحالة الحيّة (2026-10-05): active=0, max=5, paused=false.
   - الإصلاح المقترح: حد أدنى لقيمة المركز + `totalPayable > 0`.
2. **الإيقاف المؤقت لا يوقف عدّاد التأخر.** `payInstallment` و`earlyRepayCash` و`addCollateral` كلها `whenNotPaused`، لكن `nextDueDate + GRACE_PERIOD` يستمر في الجريان، فتصبح المراكز قابلة للتصفية فور رفع الإيقاف. ودليلا RECONCILE وROLLBACK يتطلبان الإيقاف.
3. **تعطّل سعر أصل واحد يمنع الإنقاذ (addCollateral) ولا يمنع التصفية.** `_enforceCap(CAP_RESCUE)` يسعّر كل الأصول المودعة. وأي accountingFault له الأثر نفسه.
4. **cbBTC يُسعَّر من BTC/USD.** إن فقد cbBTC ارتباطه بسعر البتكوين يبقى مُقيَّماً بسعر BTC كاملاً. البديل: تغذية cbBTC/USD من Chainlink على Base.
5. **سؤال عن المفاتيح:** عنوان الـkeeper `0xef6F…c2e4` هو أيضاً الموقّع #1 في الـSafe، والمالك الوحيد لـBtcEscrowMurabaha. اختراق خادم الـkeeper يعطي المهاجم توقيعاً من التوقيعين اللازمين للترقية.
