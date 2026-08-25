import { expect } from "chai";
import { vaultAddress } from "../scripts/lib/vault";

/**
 * تكافؤ اشتقاق الخزنة بين نسختَي TypeScript و Rust.
 *
 * الـdaemon يراقب العنوان الذي تشتقّه TS، والتطبيق يعرض ما تشتقّه Rust.
 * أي تباين = المستخدم يودع في عنوان، والـdaemon يراقب آخر، والصفقة تعلق
 * وأموال قد تضيع. هذا الاختبار هو الحارس الوحيد بينهما.
 *
 * المتجه: مفاتيح خزنة قسط الحقيقية عند الفهرس 0.
 */
const BUYER = "0x02cd3dd64bd4ffd7a586208e4a37168cb62b93e23bbae0b715dd4a6d0a7e16d679";
const SELLER = "0x036b0ba693adb3e311a0d336ab2efa71500814961a064d2f04ee623d844a9e5f05";
const QIST = "0x039f967798fea0125d24effdad335011445f68da3475284df05d4faf161fed8bfc";

/// العنوان المشتقّ من نواة Rust لنفس المتجه — وهو أيضاً عنوان خزنة قسط
/// الحقيقية التي أنشأها المستخدم في Blue Wallet مستقلاً. تطابقه الثلاثي
/// (Rust ↔ TS ↔ Blue Wallet) يثبت صحّة الاشتقاق لا مجرد اتساقه.
const RUST_ADDRESS =
  "bc1qh2pz6t8crs7ykxh66emp2huxm5futgdsget5wd5jsuhnnug42nks2q3vsn";

describe("تكافؤ اشتقاق الخزنة (TS ↔ Rust)", () => {
  it("🔒 يطابق عنوان نواة Rust حرفياً — الحارس الأهم", () => {
    expect(vaultAddress(BUYER, SELLER, QIST)).to.equal(RUST_ADDRESS);
  });

  it("ينتج عنوان P2WSH صالحاً على mainnet", () => {
    const a = vaultAddress(BUYER, SELLER, QIST);
    expect(a).to.match(/^bc1q/);
    expect(a).to.have.length(62);
  });

  it("لا يتأثّر بترتيب الأطراف (BIP-67)", () => {
    const a = vaultAddress(BUYER, SELLER, QIST);
    const b = vaultAddress(QIST, BUYER, SELLER);
    const c = vaultAddress(SELLER, QIST, BUYER);
    expect(a).to.equal(b);
    expect(b).to.equal(c);
  });

  it("يقبل المفاتيح مع 0x وبدونها بنفس النتيجة", () => {
    const withPrefix = vaultAddress(BUYER, SELLER, QIST);
    const without = vaultAddress(
      BUYER.slice(2), SELLER.slice(2), QIST.slice(2)
    );
    expect(withPrefix).to.equal(without);
  });

  it("يرفض مفتاحاً بطول خاطئ", () => {
    expect(() => vaultAddress("0x02ab", SELLER, QIST)).to.throw("66 حرف");
  });

  it("يرفض مفتاحاً غير مضغوط (بادئة 04)", () => {
    expect(() => vaultAddress("04" + "11".repeat(32), SELLER, QIST))
      .to.throw("02 أو 03");
  });
});
