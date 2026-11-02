import XCTest
@testable import RenewCore

final class ReminderPlanTests: XCTestCase {
    private func instant(_ s: String) -> Date { ISO8601DateFormatter().date(from: s)! }
    private func item() -> Subscription {
        Subscription(name: "Example", amount: 96, currency: "USD", cadence: .annual,
                     nextBilling: Day.parse("2027-03-16"), accessEnds: Day.parse("2027-03-24"),
                     evidence: "Reviewed sample terms", reminderDays: 3)
    }
    func testCivilLeadSpansDaylightSavingBoundary() throws {
        let plan = try XCTUnwrap(ReminderPlan.make(item(), now: instant("2027-03-01T20:00:00Z"),
                                                   timeZone: TimeZone(identifier: "America/New_York")!))
        XCTAssertEqual(plan.fireAt, instant("2027-03-13T14:00:00Z")) // 9AM EST, before the clock change.
        XCTAssertFalse(plan.isCatchUp)
    }
    func testMissedLeadGetsCatchUpButPastEventDoesNotRollForward() throws {
        let now = instant("2027-03-16T03:00:00Z")
        let zone = TimeZone(identifier: "Asia/Taipei")!
        let plan = try XCTUnwrap(ReminderPlan.make(item(), now: now, timeZone: zone))
        XCTAssertTrue(plan.isCatchUp)
        XCTAssertEqual(plan.fireAt, now.addingTimeInterval(5))
        XCTAssertNil(ReminderPlan.make(item(), now: instant("2027-03-16T16:00:00Z"), timeZone: zone))
    }
    func testNonrenewingUsesExplicitAccessEndAndDisabledRemindersStayOff() throws {
        let now = instant("2027-03-01T00:00:00Z")
        var s = item()
        s.renewing = false
        XCTAssertEqual(ReminderPlan.make(s, now: now)?.eventDay, "2027-03-24")
        s.accessEnds = nil
        XCTAssertNil(ReminderPlan.make(s, now: now))
        s.renewing = true; s.reminderDays = nil
        XCTAssertNil(ReminderPlan.make(s, now: now))
    }
    func testSameEventKeepsIdentityAcrossPreferenceChange() throws {
        var s = item()
        let now = instant("2027-03-01T00:00:00Z")
        let a = try XCTUnwrap(ReminderPlan.make(s, now: now))
        s.reminderDays = 7
        let b = try XCTUnwrap(ReminderPlan.make(s, now: now))
        XCTAssertEqual(a.identifier, b.identifier)
        XCTAssertNotEqual(a.fingerprint, b.fingerprint)
    }

    func testCancellationStopsBillingRemindersAndKeepsOnlyAnExplicitAccessEnd() {
        var subscription = item()
        let now = instant("2027-03-01T00:00:00Z")
        subscription.status = .canceled
        XCTAssertEqual(ReminderPlan.make(subscription, now: now)?.title, "Example access is ending")
        subscription.accessEnds = nil
        XCTAssertNil(ReminderPlan.make(subscription, now: now))
        subscription.status = .active
        subscription.amount = nil
        XCTAssertEqual(ReminderPlan.make(subscription, now: now)?.eventDay, "2027-03-16")
        XCTAssertFalse(ReminderPlan.make(subscription, now: now)?.body.contains("0.00") ?? true)
    }
}

final class RecordStoreTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("renew-before-tests-" + UUID().uuidString)
    }
    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }

    func testLegacyRenewalSettingAndConfirmedCancellationSurviveRelaunch() throws {
        let store = RecordStore(url: root.appendingPathComponent("records.json"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let oldRecord = """
        [{"id":"33fb03ef-9a10-4dc0-af2b-87ba8eb5e51b","name":"Example","amount":24,
          "currency":"USD","cadence":"annual","verifiedAt":"2025-01-02T03:04:05Z",
          "evidence":"Manual","renewing":false}]
        """
        try Data(oldRecord.utf8).write(to: store.url)
        var saved = try XCTUnwrap(store.load().first)
        XCTAssertEqual(saved.status, .notRenewing)
        saved.status = .active
        try store.save(saved, verify: true)
        XCTAssertEqual(Ledger.spendingSummary(try store.load()).annualByCurrency, ["USD": 24])
        saved.status = .canceled
        saved.amount = nil
        saved.cadence = nil
        try store.save(saved, verify: true)
        let canceled = try XCTUnwrap(RecordStore(url: store.url).load().first)
        XCTAssertEqual(canceled.status, .canceled)
        XCTAssertNil(canceled.amount)
        XCTAssertNil(canceled.cadence)
        XCTAssertTrue(Ledger.monthlyTotals([canceled]).isEmpty)
    }
    func testReviewPersistsAcrossRestartWithoutInventingFreshVerification() throws {
        let store = RecordStore(url: root.appendingPathComponent("records.json"))
        XCTAssertTrue(try store.load().isEmpty)
        let item = Subscription(name: "Example", amount: 12, currency: "usd", evidence: "Receipt", receiptID: "fixture-id")
        let first = Date(timeIntervalSince1970: 1_700_000_000), later = first.addingTimeInterval(86_400)
        XCTAssertThrowsError(try store.save(item, verify: false))
        _ = try store.save(item, verify: true, now: first)
        var record = try XCTUnwrap(store.load().first)
        XCTAssertEqual(record.verifiedAt, first)
        record.reminderDays = 3
        _ = try store.save(record, verify: false, now: later)
        XCTAssertEqual(try store.load().first?.verifiedAt, first)
        record.amount = 15
        XCTAssertThrowsError(try store.save(record, verify: false, now: later))
        _ = try store.save(record, verify: true, now: later)
        XCTAssertEqual(try store.load().first?.verifiedAt, later)
        record.id = UUID()
        XCTAssertThrowsError(try store.save(record, verify: true))
        XCTAssertEqual(try store.load().count, 1)
        _ = try store.remove(item.id)
        XCTAssertTrue(try store.load().isEmpty)
    }
    func testSubsequentReceiptUpdatesSameRecordAndOlderReceiptCannotCreateAnother() throws {
        let store = RecordStore(url: root.appendingPathComponent("records.json"))
        var item = Subscription(name: "Example", amount: 12, currency: "USD", evidence: "First bill", receiptID: "first")
        _ = try store.save(item, verify: true)
        item.amount = 18; item.receiptID = "second"; item.evidence = "New bill"
        _ = try store.save(item, verify: true)
        let saved = try XCTUnwrap(store.load().first)
        XCTAssertEqual(saved.receiptHistory, ["first"])
        XCTAssertEqual(try store.load().count, 1)
        item.id = UUID()
        item.receiptID = "first"
        XCTAssertThrowsError(try store.save(item, verify: true))
    }

    func testUnreadableLedgerIsNeverOverwritten() throws {
        let url = root.appendingPathComponent("records.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let bad = Data("broken existing data".utf8)
        try bad.write(to: url)
        let store = RecordStore(url: url)
        XCTAssertThrowsError(try store.save(Subscription(name: "Example", amount: 12, currency: "USD", evidence: "Manual"), verify: true))
        XCTAssertEqual(try Data(contentsOf: url), bad)
    }
}
