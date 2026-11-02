import Foundation
import XCTest
@testable import RenewCore

final class DecisionPlanTests: XCTestCase {
    private let zone = TimeZone(identifier: "Asia/Taipei")!
    private let now = ISO8601DateFormatter().date(from: "2026-11-01T02:00:00Z")!

    private func project() -> Subscription {
        var item = Subscription(name: "Music tool", amount: 12, currency: "USD", cadence: .monthly,
                                nextBilling: Day.parse("2026-12-01"), reminderDays: 3)
        item.purpose = "Launch video"
        item.needsUntil = Day.parse("2026-11-20")
        return item
    }

    func testProjectEndsBeforeRenewalAndLaterRescheduleRetainsEarlierBillingReview() throws {
        var item = project()
        let project = DecisionPlan.make(item, now: now, timeZone: zone)
        XCTAssertEqual(project.kind, .project)
        XCTAssertEqual(project.dueOn, Day.parse("2026-11-20"))
        XCTAssertTrue(project.reason.contains("Launch video"))
        item.reviewOn = Day.parse("2026-12-10")
        let moved = DecisionPlan.make(item, now: now, timeZone: zone)
        XCTAssertEqual(moved.kind, .renewal)
        XCTAssertEqual(moved.dueOn, Day.parse("2026-11-28"))
        XCTAssertNotEqual(project.key, moved.key)
        XCTAssertTrue(moved.reason.contains("Confirm the cancellation cutoff"))
    }

    func testAcknowledgmentStopsExactReviewAndDateChangesRequireAnotherDecision() throws {
        var item = project()
        let decision = DecisionPlan.make(item, now: now, timeZone: zone)
        item.reviewedDecisionKey = decision.key
        item.decisionReviewedAt = now
        XCTAssertFalse(DecisionPlan.make(item, now: now, timeZone: zone).needsReview)
        XCTAssertNil(ReminderPlan.make(item, now: now, timeZone: zone))
        item.needsUntil = Day.parse("2026-11-21")
        XCTAssertTrue(DecisionPlan.make(item, now: now, timeZone: zone).needsReview)
        XCTAssertNotNil(ReminderPlan.make(item, now: now, timeZone: zone))
        XCTAssertEqual(item.nextBilling, Day.parse("2026-12-01"))
        XCTAssertTrue(item.renewing)
    }

    func testKnownCivilCancellationCutoffSchedulesBeforeThatDayBegins() throws {
        var item = project()
        item.needsUntil = nil
        item.cancelBy = Day.parse("2026-11-10")
        item.reminderDays = 0
        let decision = DecisionPlan.make(item, now: now, timeZone: zone)
        let reminder = try XCTUnwrap(ReminderPlan.make(item, now: now, timeZone: zone))
        XCTAssertEqual(decision.kind, .cancellation)
        XCTAssertEqual(decision.dueOn, Day.parse("2026-11-09"))
        XCTAssertEqual(reminder.fireAt, ISO8601DateFormatter().date(from: "2026-11-09T01:00:00Z"))
    }

    func testKeptPeriodReturnsForVerificationAfterKnownBillPasses() throws {
        var item = project()
        item.reviewedDecisionKey = DecisionPlan.make(item, now: now, timeZone: zone).key
        item.decisionReviewedAt = now
        let afterBill = ISO8601DateFormatter().date(from: "2026-12-02T02:00:00Z")!
        let decision = DecisionPlan.make(item, now: afterBill, timeZone: zone)
        XCTAssertTrue(decision.needsReview)
        XCTAssertEqual(decision.kind, .verify)
        XCTAssertTrue(decision.reason.contains("has passed"))
        XCTAssertEqual(item.nextBilling, Day.parse("2026-12-01"))
        XCTAssertNil(ReminderPlan.make(item, now: afterBill, timeZone: zone))
    }

    func testProjectWithoutKnownBillGetsReminderAndOverdueWorkStaysActionable() throws {
        var item = project()
        item.nextBilling = nil
        item.needsUntil = Day.parse("2026-10-31")
        let decision = DecisionPlan.make(item, now: now, timeZone: zone)
        XCTAssertTrue(decision.isOverdue)
        XCTAssertEqual(decision.dueOn, Day.parse("2026-10-31"))
        let reminder = try XCTUnwrap(ReminderPlan.make(item, now: now, timeZone: zone))
        XCTAssertTrue(reminder.isCatchUp)
        XCTAssertEqual(reminder.fireAt, now.addingTimeInterval(5))
        XCTAssertEqual(reminder.eventDay, "2026-10-31")
        XCTAssertNil(item.nextBilling)
    }

    func testUnknownDatesStayExplicitAndRenewalOffUsesAccessOnly() throws {
        var item = project()
        item.needsUntil = nil
        item.nextBilling = nil
        let unknown = DecisionPlan.make(item, now: now, timeZone: zone)
        XCTAssertNil(unknown.dueOn)
        XCTAssertEqual(unknown.kind, .verify)
        XCTAssertEqual(unknown.actionLabel, "Add a date")
        item.needsUntil = Day.parse("2026-11-10")
        item.status = .canceled
        XCTAssertNil(ReminderPlan.make(item, now: now, timeZone: zone))
        item.accessEnds = Day.parse("2026-11-30")
        let access = DecisionPlan.make(item, now: now, timeZone: zone)
        XCTAssertEqual(access.kind, .access)
        XCTAssertEqual(access.eventOn, Day.parse("2026-11-30"))
    }

    func testIntentAndKeepSurviveRestartWithoutRefreshingBillingEvidence() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = RecordStore(url: folder.appendingPathComponent("records.json"))
        let verified = now.addingTimeInterval(-86_400)
        var item = project()
        try store.save(item, verify: true, now: verified)
        item.purpose = "Final edit"
        item.needsUntil = Day.parse("2026-11-25")
        item.reviewOn = Day.parse("2026-11-24")
        item.isEssential = true
        item.reviewedDecisionKey = DecisionPlan.make(item, now: now, timeZone: zone).key
        item.decisionReviewedAt = now
        try store.save(item, verify: false, now: now)
        let restored = try XCTUnwrap(RecordStore(url: store.url).load().first)
        XCTAssertEqual(restored.purpose, "Final edit")
        XCTAssertEqual(restored.needsUntil, item.needsUntil)
        XCTAssertEqual(restored.isEssential, true)
        XCTAssertEqual(restored.verifiedAt, verified)
        XCTAssertFalse(DecisionPlan.make(restored, now: now, timeZone: zone).needsReview)
        item.cancelBy = Day.parse("2026-11-15")
        XCTAssertThrowsError(try store.save(item, verify: false, now: now))
        item.cancelBy = nil
        item.billingChannel = "apple"
        XCTAssertThrowsError(try store.save(item, verify: false, now: now))
        try store.save(item, verify: true, now: now)
        XCTAssertEqual(try store.load().first?.billingChannel, "apple")
        item.billingChannel = "untrusted"
        XCTAssertThrowsError(try store.save(item, verify: true, now: now))
        item.billingChannel = "apple"
        item.amount = 20
        XCTAssertThrowsError(try store.save(item, verify: false, now: now))
    }
}
