import Foundation
import XCTest
@testable import RenewCore

final class SubscriptionActionsTests: XCTestCase {
    let now = ISO8601DateFormatter().date(from: "2026-11-02T02:00:00Z")!
    func item() -> Subscription {
        Subscription(name: "Suno", amount: 10, currency: "USD", cadence: .monthly,
                     nextBilling: Day.parse("2026-11-20"), verifiedAt: now.addingTimeInterval(-86400), reminderDays: 3)
    }

    func testKeepAcknowledgesOnlyThisCycleAndPreservesBillingFacts() throws {
        let original = item()
        let kept = try SubscriptionActions.keeping(original, now: now)
        XCTAssertTrue(kept.renewing)
        XCTAssertEqual(kept.nextBilling, original.nextBilling)
        XCTAssertEqual(kept.verifiedAt, original.verifiedAt)
        XCTAssertFalse(DecisionPlan.make(kept, now: now).needsReview)
        XCTAssertNil(ReminderPlan.make(kept, now: now))
        XCTAssertTrue(DecisionPlan.make(kept, now: now.addingTimeInterval(25 * 86400)).needsReview)
    }

    func testUnknownOrPastBillingCannotBeSilentlyKept() {
        var unknown = item(); unknown.nextBilling = nil
        XCTAssertThrowsError(try SubscriptionActions.keeping(unknown, now: now))
        unknown.nextBilling = Day.parse("2026-11-01")
        XCTAssertThrowsError(try SubscriptionActions.keeping(unknown, now: now))
    }

    func testReminderReopensKeptCycleAndSchedulesExactlyChosenCivilDay() throws {
        let kept = try SubscriptionActions.keeping(item(), now: now)
        let date = Day.parse("2026-11-18")!
        let updated = try SubscriptionActions.reminding(kept, on: date, now: now)
        let plan = try XCTUnwrap(ReminderPlan.make(updated, now: now, timeZone: TimeZone(identifier: "Asia/Taipei")!))
        XCTAssertEqual(plan.fireAt, ISO8601DateFormatter().date(from: "2026-11-18T01:00:00Z"))
        XCTAssertNil(updated.reviewedDecisionKey)
        XCTAssertEqual(updated.verifiedAt, kept.verifiedAt)
        XCTAssertTrue(updated.renewing)
        XCTAssertNil(SubscriptionActions.nextToReview([updated], now: now))
        XCTAssertEqual(SubscriptionActions.nextToReview([updated], now: now.addingTimeInterval(17 * 86400))?.id, updated.id)
    }

    func testReminderRejectsPastBillingDayAndCancellationDeadline() {
        var original = item()
        for day in ["2026-11-01", "2026-11-02", "2026-11-20", "2026-11-21"] {
            XCTAssertThrowsError(try SubscriptionActions.reminding(original, on: Day.parse(day)!, now: now))
        }
        original.cancelBy = Day.parse("2026-11-10")
        XCTAssertThrowsError(try SubscriptionActions.reminding(original, on: Day.parse("2026-11-10")!, now: now))
    }

    func testRenewalOffPreservesPriceVerificationAndPaymentsAcrossRestart() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = RecordStore(url: folder.appendingPathComponent("records.json"))
        let original = item()
        try store.save(original, verify: true, now: original.verifiedAt)
        let suite = "org.renewbefore.actions-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let payments = PaymentStore(defaults: defaults)
        let payment = RecordedPayment(id: "paid-before-cancel", service: original.name, amount: 10, currency: "USD", day: Day.fromLocal(now), dateSource: .manual)
        _ = try payments.merge([payment], mailbox: "")
        try store.confirmRenewalOff(original.id, now: now)
        let restored = try XCTUnwrap(store.load().first)
        XCTAssertFalse(restored.renewing)
        XCTAssertEqual(restored.status, .canceled)
        XCTAssertEqual(restored.renewalOffConfirmedAt, now)
        XCTAssertEqual(restored.verifiedAt, original.verifiedAt)
        XCTAssertEqual(restored.amount, original.amount)
        XCTAssertEqual(restored.nextBilling, original.nextBilling)
        XCTAssertTrue(Ledger.monthlyTotals([restored]).isEmpty)
        XCTAssertEqual(try payments.load(mailbox: ""), [payment])
        XCTAssertThrowsError(try store.confirmRenewalOff(UUID()))
    }

    func testSummaryKeepsCurrenciesSeparateAndAccountsForAnnualAndUnknownRates() {
        var annual = item(); annual.id = UUID(); annual.amount = 120; annual.cadence = .annual
        var twd = item(); twd.id = UUID(); twd.currency = "TWD"; twd.amount = 100
        var unknown = item(); unknown.id = UUID(); unknown.cadence = nil
        let off = SubscriptionActions.confirmingRenewalOff(item(), now: now)
        let totals = Ledger.spendingSummary([item(), annual, twd, unknown, off])
        XCTAssertEqual(totals.monthlyByCurrency, ["USD":20,"TWD":100])
        XCTAssertEqual(totals.excludedActiveCount, 1)
    }
}
