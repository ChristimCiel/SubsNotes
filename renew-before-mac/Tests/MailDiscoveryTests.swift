import Foundation
import XCTest
@testable import RenewCore

final class MailDiscoveryTests: XCTestCase {
    private func mail(_ id: String = "abc", _ subject: String, _ body: String,
                      sender: String = "Paper Kite Billing <receipts@billing.paperkite.example>",
                      at time: TimeInterval = 1_800_000_000) -> MailScanMessage {
        MailScanMessage(id: id, subject: subject, sender: sender, body: body, receivedAt: Date(timeIntervalSince1970: time))
    }

    private func find(_ messages: [MailScanMessage], mailbox: String = "personal@example.invalid") -> [MailCandidate] {
        MailDiscovery.candidates(from: messages, mailbox: mailbox)
    }

    func testMailboxScopesServiceAndMessageIdentitiesAcrossAccounts() throws {
        let message = mail("same-id", "Your subscription receipt", "Recurring amount: USD 9/month")
        let home = try XCTUnwrap(find([message], mailbox: "Person@example.invalid").first)
        let same = try XCTUnwrap(find([message], mailbox: " person@EXAMPLE.invalid ").first)
        let work = try XCTUnwrap(find([message], mailbox: "person@company.invalid").first)
        XCTAssertEqual(home.id, same.id)
        XCTAssertEqual(home.draft.receiptID, same.draft.receiptID)
        XCTAssertNotEqual(home.id, work.id)
        XCTAssertNotEqual(home.draft.receiptID, work.draft.receiptID)
    }

    func testRenewalWithNaturalWordingShowsExplicitTermsAndSource() throws {
        let notice = mail("jan", "Your subscription renewal reminder", """
        Your membership renews on March 20, 2030.
        Your price is USD 12.50 per month.
        Reference: example-123
        """)
        let candidate = try XCTUnwrap(find([notice]).first)
        XCTAssertEqual(candidate.kind, .renewal)
        XCTAssertEqual(candidate.name, "Paper Kite")
        XCTAssertEqual(candidate.draft.amount, Decimal(string: "12.50"))
        XCTAssertEqual(candidate.draft.currency, "USD")
        XCTAssertEqual(candidate.draft.cadence, .monthly)
        XCTAssertEqual(candidate.draft.nextBilling, Day.parse("2030-03-20"))
        XCTAssertEqual(candidate.receivedAt, notice.receivedAt)
        XCTAssertEqual(candidate.subject, notice.subject)
        XCTAssertEqual(candidate.sender, notice.sender)
        XCTAssertTrue(candidate.draft.excerpt.contains("membership renews"))
        XCTAssertFalse(candidate.draft.excerpt.contains("example-123"))
    }

    func testGroupRepeatedReceiptsAndUseLatestEvidenceWithoutTransplantingOldFields() throws {
        let earlier = mail("earlier", "Your subscription receipt", "Recurring amount: EUR 80/year\nNext billing date: 2030-03-29", at: 100)
        let problem = mail("later", "Your subscription payment failed", "Our attempt to charge your card failed.\nNext billing date: 2030-03-29", at: 200)
        let results = find([earlier, problem, earlier])
        let result = try XCTUnwrap(results.first)
        XCTAssertEqual(results.count, 2)
        XCTAssertEqual(result.messageCount, 1)
        XCTAssertEqual(result.kind, .paymentProblem)
        XCTAssertEqual(result.receivedAt, problem.receivedAt)
        XCTAssertNil(result.draft.amount)
        XCTAssertNil(result.draft.nextBilling)
        XCTAssertNotEqual(result.id, find([earlier]).first?.id)
        XCTAssertEqual(result.draft.receiptID, find([problem]).first?.draft.receiptID)
        XCTAssertNotEqual(result.draft.receiptID, find([earlier]).first?.draft.receiptID)
    }

    func testLaterReceiptNeverClearsPaymentProblemAndResolutionPersists() throws {
        let failed = mail("failure", "Subscription payment failed", "Service: Cloud host\nYour subscription payment failed.", at: 100)
        let paid = mail("paid", "Your subscription receipt", "Service: Cloud host\nMonthly subscription\nAmount paid: USD 24", at: 200)
        let findings = find([failed, paid])
        XCTAssertEqual(Set(findings.map(\.kind)), [.receipt, .paymentProblem])
        let problem = try XCTUnwrap(findings.first { $0.kind == .paymentProblem })
        var inbox = MailReviewInbox()
        let summary = MailScanSummary(inspected: 2, limited: false, skipped: 0)
        inbox.merge([problem], at: Date(), summary: summary)
        inbox.merge(find([paid]), at: Date(), summary: summary)
        var saved = Subscription()
        saved.receiptID = problem.draft.receiptID
        XCTAssertTrue(inbox.pending(for: [saved]).contains { $0.kind == .paymentProblem })
        inbox = try JSONDecoder().decode(MailReviewInbox.self, from: JSONEncoder().encode(inbox))
        inbox.dismiss(problem)
        inbox.merge(findings, at: Date(), summary: summary)
        XCTAssertFalse(inbox.pending(for: []).contains { $0.kind == .paymentProblem })
        XCTAssertEqual(find([failed], mailbox: "other@example.invalid").count, 1)
        XCTAssertNotEqual(problem.id, find([failed], mailbox: "other@example.invalid").first?.id)
    }

    func testLegacyProblemSurvivesMergeBeforeExplicitResolution() throws {
        let original = try XCTUnwrap(find([mail("failure", "Subscription payment failed", "Monthly subscription payment failed")]).first)
        var inbox = MailReviewInbox()
        let summary = MailScanSummary(inspected: 1, limited: false, skipped: 0)
        inbox.merge([original], at: Date(), summary: summary)
        // Recreate the v0.3 cache where the problem was stored with a merchant-only identity.
        let data = try JSONEncoder().encode(inbox)
        let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: original.id, with: "legacy-merchant")
        inbox = try JSONDecoder().decode(MailReviewInbox.self, from: Data(text.utf8))
        let reopened = try XCTUnwrap(inbox.pending(for: []).first)
        XCTAssertEqual(reopened.id, original.id)
        inbox.dismiss(reopened)
        XCTAssertTrue(inbox.pending(for: []).isEmpty)
    }

    func testCancellationIsEvidenceNotAnUpcomingCharge() throws {
        let ending = mail("end", "Subscription cancellation confirmation", "Your subscription has been cancelled.\nNext billing date: 2030-04-01")
        let result = try XCTUnwrap(find([ending]).first)
        XCTAssertEqual(result.kind, .cancellation)
        XCTAssertNil(result.draft.nextBilling)
    }

    func testRejectShoppingMarketingUsageAndQuotedOldMessages() {
        let unrelated = [
            mail("1", "Receipt for your new headphones", "Order total: USD 69.00\nManage your subscriptions"),
            mail("2", "Start your free trial", "Subscribe today to a monthly plan, USD 5/month."),
            mail("3", "Your cloud invoice", "This subscription is billed for metered usage.\nBilling period: February"),
            mail("4", "Your invoice", "One-time purchase.\nFind our monthly plan at USD 14/month."),
            mail("5", "Your email newsletter subscription", "Your subscription has been confirmed."),
            mail("6", "Re: your subscription payment failed", "Can you forward me that when you get a minute?"),
            mail("7", "Your order receipt", "Thanks for shopping.\nOn Thu, Taylor wrote:\nYour subscription renews on 2030-07-01.")
        ]
        XCTAssertTrue(find(unrelated).isEmpty)
    }

    func testReceiptTotalAndHistoricalInvoiceDateDoNotBecomePlanPriceAndNextBill() throws {
        let receipt = mail("r", "Your subscription receipt", "Invoice date: 2030-06-12\nTotal paid: USD 140\nManage your plan online.")
        let result = try XCTUnwrap(find([receipt]).first)
        XCTAssertEqual(result.kind, .receipt)
        XCTAssertNil(result.draft.nextBilling)
        XCTAssertNil(result.draft.amount)
        XCTAssertNil(result.draft.cadence)
        XCTAssertNil(result.draft.currency)
    }

    func testProcessorsStaySeparateAndRequireAnIdentifiableMerchant() throws {
        let relay = "Stripe <receipts@stripe.com>"
        let a = mail("a", "Your receipt from Atlas Sky", "Recurring amount: EUR 5.00/year", sender: relay)
        let b = mail("b", "Your receipt from Ember Sky", "Your subscription. Billed monthly.", sender: relay)
        let c = mail("c", "Your subscription receipt", "Billing cycle: Monthly", sender: relay)
        let found = find([a, b, c])
        XCTAssertEqual(Set(found.map(\.name)), Set(["Atlas Sky", "Ember Sky"]))
        let draft = try XCTUnwrap(found.first { $0.name == "Atlas Sky" }?.draft)
        XCTAssertEqual(draft.amount, Decimal(5))
        XCTAssertEqual(draft.currency, "EUR")
        XCTAssertEqual(draft.cadence, .annual)
    }

    func testSameIssuerCanHaveDistinctNamedPlansAndCurrencyStaysUnknownForBareDollar() throws {
        let one = mail("1", "Your subscription receipt", "Product: Storage Pro\nYour price is $5/month.")
        let two = mail("2", "Your subscription receipt", "Product: Notes Pro\nRecurring charge: CAD 8/month")
        let results = find([one, two])
        XCTAssertEqual(results.count, 2)
        let draft = try XCTUnwrap(results.first { $0.name == "Storage Pro" }?.draft)
        XCTAssertEqual(draft.amount, Decimal(5))
        XCTAssertNil(draft.currency)
        XCTAssertEqual(draft.cadence, .monthly)
    }

    func testConflictingPricesAndDatesStayUnknown() throws {
        let notice = mail("r", "Renewal notice", "Subscription price: USD 19/month\nRecurring charge: EUR 42/year\nNext billing date: 2030-02-01\nWill renew on February 4, 2030.")
        let draft = try XCTUnwrap(find([notice]).first?.draft)
        XCTAssertNil(draft.amount)
        XCTAssertNil(draft.currency)
        XCTAssertNil(draft.cadence)
        XCTAssertNil(draft.nextBilling)
    }

    func testMarketingFooterAndConditionalFailureDoNotOverrideReceipt() throws {
        let message = mail("id", "Your subscription receipt", "Recurring amount: CA$12/month\nUpgrade to Pro for USD 99/year.\nIf your payment failed, contact support.")
        let candidate = try XCTUnwrap(find([message]).first)
        XCTAssertEqual(candidate.kind, .receipt)
        XCTAssertEqual(candidate.draft.amount, Decimal(12))
        XCTAssertEqual(candidate.draft.currency, "CAD")
        XCTAssertEqual(candidate.draft.cadence, .monthly)
    }

    func testRescanWithChangedBodyFormattingKeepsMessageIdentity() throws {
        let body = "Recurring amount: USD 4/month"
        let original = mail("stable-id", "Your subscription receipt", body)
        let formatted = mail("stable-id", "Your subscription receipt", body + "\n\nThank you!")
        let findings = find([original, formatted])
        XCTAssertEqual(findings.count, 1)
        XCTAssertEqual(findings.first?.messageCount, 1)
    }

    func testEndingNoticeIsDistinctFromCancellationAndIgnoresConditionalInstructions() throws {
        let ending = mail("end", "Your subscription will not renew", "Next billing date: 2030-04-01")
        let zh = mail("zh", "訂閱已取消", "您的訂閱已取消，感謝您使用。")
        let zhReceipt = mail("r", "您的訂閱收據", "訂閱付款成功。\n若您的訂閱已取消，請聯絡客服。")
        XCTAssertEqual(try XCTUnwrap(find([ending]).first).kind, .ending)
        XCTAssertNil(find([ending]).first?.draft.nextBilling)
        XCTAssertEqual(find([zh]).first?.kind, .cancellation)
        XCTAssertEqual(find([zhReceipt]).first?.kind, .receipt)
        XCTAssertTrue(find([mail("offer", "訂閱優惠", "現在訂閱即可獲得優惠和收據。")]).isEmpty)
    }

    func testDashboardInboxSurvivesNarrowerScansRelaunchAndOnlyStoresExtractedFields() throws {
        let suite = "org.renewbefore.tests.review." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MailReviewStore(defaults: defaults)
        let mailbox = "owner@example.invalid"
        let note = mail("receipt-id", "Private subject subscription receipt", "Service: Test Studio\nRecurring charge: USD 5/month\nBilling support: secret excerpt", at: 100)
        let first = try XCTUnwrap(find([note], mailbox: mailbox).first)
        let empty = MailScanSummary(inspected: 0, limited: false, skipped: 0)
        let partial = MailScanSummary(inspected: 30, limited: true, skipped: 1)
        _ = try store.update(mailbox: mailbox) { $0.merge([first], at: Date(timeIntervalSince1970: 200), summary: partial) }
        let at = Date(timeIntervalSince1970: 400)
        _ = try store.update(mailbox: mailbox) { $0.merge([], at: at, summary: empty) }
        let reopened = try MailReviewStore(defaults: defaults).load(mailbox: "OWNER@example.invalid")
        XCTAssertEqual(reopened.lastScanAt, at)
        XCTAssertEqual(reopened.lastScanSummary?.inspected, 0)
        let cached = try XCTUnwrap(reopened.pending(for: []).first)
        XCTAssertEqual(cached.draft.amount, 5)
        XCTAssertTrue(cached.subject.isEmpty && cached.sender.isEmpty && cached.draft.excerpt.isEmpty)
        let sourceData = try XCTUnwrap(defaults.persistentDomain(forName: suite)?.values.first as? Data)
        let storedText = String(decoding: sourceData, as: UTF8.self)
        for privateText in ["Private subject", "secret excerpt", "receipts@billing", "receipt-id"] {
            XCTAssertFalse(storedText.contains(privateText))
        }
        XCTAssertTrue(try store.load(mailbox: "separate@example.invalid").pending(for: []).isEmpty)
        var tracked = Subscription()
        tracked.receiptHistory = [first.draft.receiptID]
        XCTAssertTrue(reopened.pending(for: [tracked]).isEmpty)
        _ = try store.update(mailbox: mailbox) { $0.dismiss(first) }
        _ = try store.update(mailbox: mailbox) { $0.merge([first], at: at, summary: partial) }
        XCTAssertTrue(try store.load(mailbox: mailbox).pending(for: []).isEmpty)
        let later = mail("cancel-id", "Subscription cancellation confirmation", "Service: Test Studio\nYour subscription has been canceled.", at: 500)
        let cancellation = try XCTUnwrap(find([later], mailbox: mailbox).first)
        XCTAssertEqual(cancellation.id, first.id)
        _ = try store.update(mailbox: mailbox) { $0.merge([cancellation, first], at: at, summary: partial) }
        XCTAssertEqual(try store.load(mailbox: mailbox).pending(for: [tracked]).map(\.kind), [.cancellation])
        store.forget(mailbox: mailbox)
        XCTAssertNil(try store.load(mailbox: mailbox).lastScanAt)
    }

    func testNamedPlanCanIdentifyProcessorReceiptWithoutUsingOffersOrMixedItems() throws {
        let relay = "Apple <receipts@apple.com>"
        let plan = mail("p", "Your receipt from Apple", "Plan: YouTube Premium\nTotal: TWD 199", sender: relay)
        XCTAssertEqual(find([plan]).first?.name, "YouTube Premium")
        let financial = PaymentDiscovery.scan(from: [plan], mailbox: "owner@qa.invalid")
        XCTAssertTrue(financial.payments.isEmpty)
        XCTAssertEqual(financial.paymentReviews.first?.options.first?.amount, 199)
        let suggested = mail("offer", "Your receipt from Apple", "Try YouTube Premium!\nTotal: TWD 199", sender: relay)
        let mixed = mail("mixed", "Your receipt from Apple", "Plan: YouTube Premium\nItem: Book\nTotal: TWD 499", sender: relay)
        let bare = mail("bare", "Your receipt from Apple", "YouTube Premium\nTotal: TWD 199", sender: relay)
        XCTAssertTrue(find([suggested, mixed, bare]).isEmpty)
    }

    func testMigrationCombinesOriginalDashboardWithNewScansAndKeepsDismissals() throws {
        let suite = "org.renewbefore.tests.migrate." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MailReviewStore(defaults: defaults), mailbox = "qa@example.invalid"
        let summary = MailScanSummary(inspected: 1, limited: false, skipped: 0)
        let first = try XCTUnwrap(find([mail("1", "Your subscription receipt", "Product: Old Studio\nRecurring amount: USD 4/month")], mailbox: mailbox).first)
        let next = try XCTUnwrap(find([mail("2", "Your subscription receipt", "Product: New Studio\nRecurring amount: USD 9/month")], mailbox: mailbox).first)
        let hidden = try XCTUnwrap(find([mail("3", "Your subscription receipt", "Product: Hidden Studio\nRecurring amount: USD 2/month")], mailbox: mailbox).first)
        let oldDate = Date(timeIntervalSince1970: 100), newDate = Date(timeIntervalSince1970: 200)
        var old = MailReviewInbox()
        old.merge([first, hidden], at: oldDate, summary: summary)
        _ = try store.update(mailbox: mailbox) { $0.merge([next], at: newDate, summary: summary); $0.dismiss(hidden) }
        defaults.set(try JSONEncoder().encode(old), forKey: "gmail.review.v1." + mailbox)
        let recovered = try store.load(mailbox: mailbox)
        XCTAssertEqual(Set(recovered.pending(for: []).map(\.id)), Set([first.id, next.id]))
        XCTAssertEqual(recovered.lastScanAt, newDate)
        XCTAssertNil(defaults.object(forKey: "gmail.review.v1." + mailbox))
        XCTAssertEqual(try store.load(mailbox: mailbox).pending(for: []).count, 2)
    }

}
