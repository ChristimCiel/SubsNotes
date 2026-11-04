import Foundation
import XCTest
@testable import RenewCore

final class LocalizationTests: XCTestCase {
    func testCanonicalLanguageCodesKeepLegacyChinesePreferencesReadable() {
        XCTAssertEqual(AppLanguage.traditionalChinese.rawValue, "zh-TW")
        for code in ["zh", "zh-TW", "zh-Hant", "zh-Hant-TW"] {
            XCTAssertEqual(AppLanguage.resolve(code), .traditionalChinese)
        }
        XCTAssertEqual(AppLanguage.resolve("en"), .english)
        XCTAssertEqual(AppLanguage.resolve(nil), .english)
        XCTAssertEqual(L10n.text("Price unknown", language: AppLanguage.resolve("zh-Hant")), "價格未知")
    }
    func testConsumerFlowsAreAvailableInBothLanguages() {
        for key in ["Subscriptions", "Payments", "Stop renewing", "Set reminder", "Yes, renewal is off",
                    "When should we remind you?", "Back to subscriptions", "Not a subscription",
                    "Your reminder is saved.", "Confirm your first subscription", "What you’ve paid"] {
            XCTAssertEqual(L10n.text(key, language: .english), key)
            XCTAssertNotEqual(L10n.text(key, language: .traditionalChinese), key)
        }
    }
    func testCoreMessagesUseExplicitLanguagesAndKeepUnknownKeysReadable() {
        XCTAssertEqual(L10n.text("Price unknown", language: .english), "Price unknown")
        XCTAssertEqual(L10n.text("Price unknown", language: .traditionalChinese), "價格未知")
        XCTAssertEqual(L10n.text("Annual", language: .traditionalChinese), "年繳")
        XCTAssertEqual(L10n.text("Review %@ before renewal", language: .traditionalChinese), "在續訂前檢查 %@")
        XCTAssertEqual(L10n.text("Uncatalogued fixture", language: .traditionalChinese), "Uncatalogued fixture")
    }

    func testChineseFormatsReorderArgumentsAndPreserveUserSuppliedValues() {
        let saved = L10n.language
        defer { L10n.language = saved }
        L10n.language = .traditionalChinese
        XCTAssertEqual(L10n.format("Update %@ from the email received %@.", "Suno", "2027-01-02"),
                       "依據 2027-01-02 收到的郵件更新 Suno。")
        XCTAssertEqual(L10n.format("Review %@ before renewal", "My custom service"), "在續訂前檢查 My custom service")
        XCTAssertEqual(L10n.format("%lld months", 12), "12 個月")
    }

    func testMoneyAndReminderContentFollowSelectedLanguageWithoutChangingIdentity() throws {
        let saved = L10n.language
        defer { L10n.language = saved }
        let now = ISO8601DateFormatter().date(from: "2027-01-01T00:00:00Z")!
        let item = Subscription(name: "My service", amount: Decimal(string: "1234.50"), currency: "USD", cadence: .monthly,
                                nextBilling: Day.parse("2027-01-15"), reminderDays: 3)
        L10n.language = .english
        let english = try XCTUnwrap(ReminderPlan.make(item, now: now))
        L10n.language = .traditionalChinese
        let chinese = try XCTUnwrap(ReminderPlan.make(item, now: now))
        XCTAssertEqual(chinese.identifier, english.identifier)
        XCTAssertEqual(chinese.eventDay, english.eventDay)
        XCTAssertEqual(chinese.subscriptionID, item.id)
        XCTAssertEqual(chinese.fireAt, english.fireAt)
        XCTAssertEqual(chinese.fingerprint, english.fingerprint)
        let parts = english.fingerprint.split(separator: "|", maxSplits: 2)
        XCTAssertTrue(chinese.matchesAcceptedFingerprint("\(parts[0])|\(parts[1])|Old English title|Old English body"))
        XCTAssertFalse(chinese.matchesAcceptedFingerprint("\(parts[0])|0|Old English title|Old English body"))
        XCTAssertEqual(chinese.title, "在續訂前檢查 My service")
        XCTAssertEqual(Ledger.displayMoney(nil, "USD"), "價格未知")
        let money = Ledger.displayMoney(Decimal(string: "1234.50"), "USD")
        XCTAssertTrue(money.contains("USD"))
        XCTAssertTrue(money.contains("1,234.50"))
        XCTAssertEqual(item.name, "My service")
        XCTAssertEqual(item.currency, "USD")
    }
}
