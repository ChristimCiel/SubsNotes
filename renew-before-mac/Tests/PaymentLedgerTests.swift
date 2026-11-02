import XCTest
@testable import RenewCore

final class PaymentLedgerTests: XCTestCase {
    private let account = "owner@example.invalid"
    private let received = Day.toLocal(Day.parse("2026-11-01")!).addingTimeInterval(12 * 3600)

    private func mail(_ id: String, _ fields: String, subject: String = "Studio subscription receipt") -> MailScanMessage {
        MailScanMessage(id: id, subject: subject, sender: "Figma <billing@figma.com>",
                        body: "Service: Figma\nMonthly subscription\n" + fields, receivedAt: received, authenticatedSenderDomain: "figma.com")
    }

    func testActualChargeOverridesListPriceAndDuplicateReceiptsKeepOnePayment() throws {
        let bill = "Invoice number: INV-7104\nRecurring amount: USD 20\nTotal: USD 24\nAmount paid: USD 18.15\nDate paid: October 30, 2026"
        let messages = [mail("a", bill), mail("b", bill), mail("c", bill.replacingOccurrences(of: "INV-7104", with: "INV-7105"))]
        let payments = PaymentDiscovery.payments(from: messages, mailbox: account)
        XCTAssertEqual(payments.count, 2)
        let payment = try XCTUnwrap(payments.first)
        XCTAssertEqual(payment.amount, Decimal(string: "18.15"))
        XCTAssertEqual(payment.day, Day.parse("2026-10-30"))
        XCTAssertEqual(payment.dateSource, .paymentDate)
        XCTAssertEqual(payment.service, "Figma")
    }

    func testDoesNotRecordRatesUnpaidInvoicesRefundsOrUnclearCurrency() {
        let cases = [
            mail("1", "Subscription price: USD 15/month"),
            mail("2", "Total: USD 19", subject: "Invoice for your Studio subscription"),
            mail("3", "Total: USD 12", subject: "Subscription payment failed"),
            mail("4", "Amount paid: USD 20", subject: "Subscription refund receipt"),
            mail("5", "Amount paid: $20"),
            mail("6", "Amount paid: EUR 15\nAmount paid: EUR 25"),
            mail("7", "Amount paid: EUR 1.250,99"),
            mail("8", "Receipt Total: USD 30\n> Amount paid: USD 30", subject: "Upcoming subscription renewal"),
            mail("9", "Amount paid: USD 0\nTotal: USD 20"),
            mail("10", "Payment status: Refunded\nAmount paid: USD 20"),
            mail("11", "Status: Unpaid\nTotal: USD 20"),
            mail("12", "Payment status:\nUnpaid\nTotal: USD 5"),
            mail("13", "Amount refunded: USD 20\nTotal: USD 20")
        ]
        XCTAssertEqual(PaymentDiscovery.payments(from: cases, mailbox: account), [])
    }

    func testDatedSettlementAndExplicitDocumentCurrency() throws {
        let value = try XCTUnwrap(PaymentDiscovery.payments(from: [mail("1","Currency: CAD\n$18.99 paid on October 30, 2026")], mailbox: account).first)
        XCTAssertEqual(value.amount, Decimal(string: "18.99"))
        XCTAssertEqual(value.currency, "CAD")
        XCTAssertEqual(value.day, Day.parse("2026-10-30"))
        XCTAssertEqual(value.dateSource, .paymentDate)
    }

    func testInstallmentsShareInvoiceButKeepDistinctTransactions() {
        let common = "Invoice number: INV-22\nAmount paid: USD 16\nTransaction ID: "
        let payments = PaymentDiscovery.payments(from: [mail("1",common + "ABC"), mail("2",common + "DEF")], mailbox: account)
        XCTAssertEqual(payments.count, 2)
    }

    func testPaidReceiptCanUseEmailDateAndThreeDigitCurrencyGrouping() throws {
        let p = try XCTUnwrap(PaymentDiscovery.payments(from: [mail("d", "Total:\nNT$1,290")], mailbox: account).first)
        XCTAssertEqual(p.amount, 1290)
        XCTAssertEqual(p.currency, "TWD")
        XCTAssertEqual(p.day, Day.fromLocal(received))
        XCTAssertEqual(p.dateSource, .emailDate)
    }

    func testOnlyOneSettledDollarAmountCanBecomeACurrencyReview() throws {
        let bare = mail("bare", "Transaction ID: PAY-104\n$18.99 paid on October 30, 2026")
        let resolved = mail("resolved", "Transaction ID: PAY-104\nAmount paid: CAD 18.99")
        let result = PaymentDiscovery.scan(from: [bare], mailbox: account)
        XCTAssertTrue(result.payments.isEmpty)
        let review = try XCTUnwrap(result.currencyReviews.first)
        XCTAssertEqual(review.amount, Decimal(string: "18.99"))
        XCTAssertEqual(review.day, Day.parse("2026-10-30"))
        XCTAssertEqual(review.dateSource, .paymentDate)
        let combined = PaymentDiscovery.scan(from: [bare, resolved], mailbox: account)
        XCTAssertEqual(combined.payments.map(\.id), [review.id])
        XCTAssertTrue(combined.currencyReviews.isEmpty)
        let nonPayments = [
            mail("1", "Amount paid: $8\nAmount paid: $12"),
            mail("2", "Payment status: Refunded\nTotal: $12"),
            mail("3", "Subscription price: $19/month"),
            mail("4", "Total: $12", subject: "Upcoming invoice for your subscription"),
            mail("5", "Amount paid: 12"),
            mail("6", "Amount paid: EUR 12\nAmount paid: $25")
        ]
        XCTAssertTrue(PaymentDiscovery.currencyReviews(from: nonPayments, mailbox: account).isEmpty)
    }

    func testDirectIssuerReceiptsRecordSpendingWithoutCreatingASubscription() throws {
        func message(_ id: String, _ sender: String, _ fields: String) -> MailScanMessage {
            MailScanMessage(id: id, subject: "Your receipt", sender: sender,
                            body: "Receipt number: REF-401\n" + fields, receivedAt: received, authenticatedSenderDomain: "anthropic.com")
        }
        let fields = "$12.50\nPaid on October 30, 2026"
        let bare = message("g1", "Billing <receipts@billing.anthropic.com>", fields)
        XCTAssertTrue(MailDiscovery.candidates(from: [bare], mailbox: account).isEmpty)
        let review = try XCTUnwrap(PaymentDiscovery.currencyReviews(from: [bare], mailbox: account).first)
        XCTAssertEqual(review.service, "Anthropic")
        XCTAssertEqual(review.amount, Decimal(string: "12.50"))
        XCTAssertEqual(review.dateSource, .paymentDate)
        let reissued = message("g2", "Billing <receipts@billing.anthropic.com>", "Total: USD 12.50\nDate paid: 2026-10-30")
        XCTAssertEqual(PaymentDiscovery.payments(from: [reissued], mailbox: account).first?.id, review.id)
        for sender in ["Anthropic <receipts@anthropic.com.example.org>", "Anthropic <receipts@not-anthropic.com>",
                       "receipts@anthropic.com <receipts@example.org>"] {
            XCTAssertTrue(PaymentDiscovery.currencyReviews(from: [message("bad", sender, fields)], mailbox: account).isEmpty)
        }
        XCTAssertTrue(PaymentDiscovery.currencyReviews(from: [message("g3", "receipts@openai.com", "Status: Pending\nTotal: $20")], mailbox: account).isEmpty)
    }

    func testMerchantIncomeAndPayoutsNeverAppearAsPaymentsOrCurrencyReviews() throws {
        func notice(_ subject: String, _ body: String) -> MailScanMessage {
            MailScanMessage(id: UUID().uuidString, subject: subject, sender: "Figma <receipts@figma.com>",
                            body: "Service: Figma\nMonthly subscription receipt\n" + body, receivedAt: received, authenticatedSenderDomain: "figma.com")
        }
        let incoming = [
            notice("You received a payment from Sam", "Amount paid: USD 24"),
            notice("Studio receipt", "A payer sent you $24 for their order.\nAmount paid: $24"),
            notice("Deposit summary", "Total: USD 24"),
            notice("Receipt from Studio", "Your weekly payout summary\nAmount paid: USD 24")
        ]
        let result = PaymentDiscovery.scan(from: incoming, mailbox: account)
        XCTAssertTrue(result.payments.isEmpty)
        XCTAssertTrue(result.currencyReviews.isEmpty)
        let outbound = notice("We received your payment", "Total: USD 24")
        XCTAssertEqual(PaymentDiscovery.payments(from: [outbound], mailbox: account).first?.amount, 24)
    }

    func testStripeOnlyAttributesAnExactSaaSMerchantAndRequiresSettlement() throws {
        func receipt(_ sender: String, _ subject: String, _ body: String) -> MailScanMessage {
            MailScanMessage(id: UUID().uuidString, subject: subject, sender: sender, body: body, receivedAt: received, authenticatedSenderDomain: "stripe.com")
        }
        let sender = "Stripe <receipts@billing.stripe.com>"
        let title = "Your receipt from Anthropic, PBC #1234"
        let body = "Your receipt\n$12.50 paid on October 30, 2026"
        let valid = receipt(sender, title, body)
        XCTAssertTrue(MailDiscovery.candidates(from: [valid], mailbox: account).isEmpty)
        let review = try XCTUnwrap(PaymentDiscovery.currencyReviews(from: [valid], mailbox: account).first)
        XCTAssertEqual(review.service, "Anthropic")
        XCTAssertEqual(review.amount, Decimal(string: "12.50"))
        let invalid = [
            receipt("Stripe <billing@stripe.com.fake.example>", title, body),
            receipt(sender, "Your receipt from Anthropic Academy #1234", body),
            receipt(sender, "Your invoice from OpenAI, LLC #1234", "Amount due: USD 12"),
            receipt(sender, title, "You received a payment from a customer.\nAmount paid: EUR 12"),
            receipt(sender, "Your Studio subscription was canceled", "Plan: Claude Pro\nInvoice number\nDate paid\nINV-401\n2026-10-30\nTotal: USD 12"),
            receipt(sender, title, "Amount paid: USD 12\nAmount paid: USD 24")
        ]
        let result = PaymentDiscovery.scan(from: invalid, mailbox: account)
        XCTAssertTrue(result.payments.isEmpty)
        XCTAssertTrue(result.currencyReviews.isEmpty)
    }

    func testCurrencyReviewSurvivesRelaunchAndRescansThenResolvesOnce() throws {
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // v0.3 ledgers written before currency review contain these two fields.
        defaults.set(Data(#"{"records":[],"excluded":[]}"#.utf8), forKey: "ledger.payments.v1." + PaymentStore.digest(account))
        let store = PaymentStore(defaults: defaults)
        let reviews = PaymentDiscovery.currencyReviews(from: [mail("1", "Amount paid: $18"), mail("2", "Amount paid: $5")], mailbox: account)
        XCTAssertEqual(reviews.count, 2)
        XCTAssertTrue(try store.merge([], reviews: reviews, mailbox: account).isEmpty)
        let restored = PaymentStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertTrue(try restored.merge([], mailbox: account).isEmpty)
        XCTAssertEqual(try restored.currencyReviews(mailbox: account).count, 2)
        XCTAssertThrowsError(try restored.confirmCurrency(reviews[0], currency: "QQQ", mailbox: account))
        XCTAssertThrowsError(try restored.confirmCurrency(reviews[0], currency: "TWD", mailbox: "else@example.invalid"))
        let confirmed = try restored.confirmCurrency(reviews[0], currency: " twd ", mailbox: account)
        XCTAssertEqual(confirmed.map(\.currency), ["TWD"])
        XCTAssertEqual(confirmed.map(\.id), [reviews[0].id])
        XCTAssertEqual(try restored.currencyReviews(mailbox: account).map(\.id), [reviews[1].id])
        XCTAssertTrue(try restored.dismissCurrencyReview(reviews[1], mailbox: account).isEmpty)
        let rescan = try restored.merge([reviews[0].payment(currency: "TWD"), reviews[1].payment(currency: "USD")], reviews: reviews, mailbox: account)
        XCTAssertEqual(rescan, confirmed)
        XCTAssertTrue(try store.currencyReviews(mailbox: account).isEmpty)
    }

    func testWindowByServiceDoesNotMixCurrenciesOrIncludeOldOrFuturePayments() {
        func row(_ day: String, _ name: String, _ value: Decimal, _ currency: String) -> RecordedPayment {
            RecordedPayment(id: UUID().uuidString, service: name, amount: value, currency: currency,
                            day: Day.parse(day)!, dateSource: .manual)
        }
        let history = [row("2026-11-01","Studio",12,"USD"), row("2026-10-03","studio",10,"USD"),
                       row("2026-10-02","Video",100,"TWD"), row("2026-11-01","Studio",4,"EUR"), row("2026-11-02","Studio",9,"USD")]
        let recent = PaymentSummary(payments: history, period: .last30, now: received)
        XCTAssertEqual(recent.totals, ["USD":22,"EUR":4])
        XCTAssertEqual(recent.byService.count, 1)
        XCTAssertEqual(recent.byService.first?.totals, recent.totals)
        XCTAssertEqual(PaymentSummary(payments: history, period: .all, now: received).totals["TWD"], 100)
    }

    func testPaymentHistorySurvivesRelaunchRescanSwitchAndExclusion() throws {
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let receipt = try XCTUnwrap(PaymentDiscovery.payments(from: [mail("e", "Amount paid: EUR 8")], mailbox: account).first)
        let initial = PaymentStore(defaults: defaults)
        XCTAssertEqual(try initial.merge([receipt], mailbox: account).count, 1)
        let restored = PaymentStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertEqual(try restored.merge([receipt], mailbox: account.uppercased()), [receipt])
        XCTAssertTrue(try restored.load(mailbox: "else@example.invalid").isEmpty)
        XCTAssertTrue(try restored.exclude(receipt, mailbox: account).isEmpty)
        XCTAssertTrue(try initial.merge([receipt], mailbox: account).isEmpty)
    }

    func testUnverifiedBrandClaimsAndForwardedReceiptsRequireReview() throws {
        let counterfeit = MailScanMessage(id: "claim", subject: "Claude Pro subscription receipt",
            sender: "Billing <sales@unrelated.example>",
            body: "Service: Claude Pro\nMonthly subscription\nAmount paid: USD 999.20",
            receivedAt: received, authenticatedSenderDomain: "unrelated.example")
        let noAuthentication = MailScanMessage(id: "no-auth", subject: "Your receipt",
            sender: "Billing <receipts@anthropic.com>", body: "Amount paid: USD 24", receivedAt: received)
        let forwarded = MailScanMessage(id: "forward", subject: "Fwd: Claude Pro subscription receipt",
            sender: "Billing <receipts@anthropic.com>",
            body: "Service: Claude Pro\nMonthly subscription\nAmount paid: USD 24",
            receivedAt: received, authenticatedSenderDomain: "anthropic.com")
        let spoofed = MailScanMessage(id: "spoof", subject: "Claude Pro subscription receipt",
            sender: "Billing <receipts@anthropic.com>",
            body: "Service: Claude Pro\nMonthly subscription\nAmount paid: USD 24",
            receivedAt: received, authenticatedSenderDomain: "unrelated.example")
        let discovery = PaymentDiscovery.scan(from: [counterfeit, noAuthentication, forwarded, spoofed], mailbox: account)
        XCTAssertTrue(discovery.payments.isEmpty)
        XCTAssertTrue(discovery.currencyReviews.isEmpty)
        XCTAssertEqual(discovery.paymentReviews.count, 4)
        XCTAssertTrue(discovery.paymentReviews.allSatisfy { $0.reason == .unverifiedMerchant })
        XCTAssertTrue(discovery.paymentReviews.flatMap(\.options).contains { $0.amount == Decimal(string: "999.20") })
    }

    func testAuthenticatedIssuerCannotAttributeAnUnrelatedProduct() {
        let message = MailScanMessage(id: "wrong-product", subject: "Subscription receipt",
            sender: "Billing <receipts@figma.com>",
            body: "Service: Claude Pro\nMonthly subscription\nAmount paid: USD 24",
            receivedAt: received, authenticatedSenderDomain: "figma.com")
        let result = PaymentDiscovery.scan(from: [message], mailbox: account)
        XCTAssertTrue(result.payments.isEmpty)
        XCTAssertEqual(result.paymentReviews.first?.reason, .unverifiedMerchant)
    }

    func testConflictingBatchAmountsStayOutOfTotalsAndSurviveRelaunch() throws {
        let messages = [mail("a", "Transaction ID: PAY-404\nAmount paid: USD 65.10"),
                        mail("b", "Transaction ID: PAY-404\nAmount paid: USD 12.40")]
        let result = PaymentDiscovery.scan(from: messages, mailbox: account)
        XCTAssertTrue(result.payments.isEmpty)
        XCTAssertTrue(result.currencyReviews.isEmpty)
        let conflict = try XCTUnwrap(result.paymentReviews.first)
        XCTAssertEqual(conflict.reason, .conflictingReceipt)
        XCTAssertEqual(conflict.options.count, 2)
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PaymentStore(defaults: defaults)
        XCTAssertTrue(try store.merge([], paymentReviews: result.paymentReviews, mailbox: account).isEmpty)
        let reopened = PaymentStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertEqual(try reopened.paymentReviews(mailbox: account), [conflict])
        let corrected = try XCTUnwrap(conflict.options.first { $0.amount == Decimal(string: "12.40") })
        let accepted = try reopened.confirmPaymentReview(conflict, optionID: corrected.id, mailbox: account)
        XCTAssertEqual(accepted.first?.amount, Decimal(string: "12.40"))
        XCTAssertEqual(try reopened.merge([], paymentReviews: result.paymentReviews, mailbox: account), accepted)
        XCTAssertTrue(try reopened.paymentReviews(mailbox: account).isEmpty)
    }

    func testCrossScanCurrencyConflictQuarantinesOriginalUntilExplicitChoice() throws {
        let original = try XCTUnwrap(PaymentDiscovery.payments(from: [mail("a", "Transaction ID: PAY-501\nAmount paid: USD 20")], mailbox: account).first)
        let changed = try XCTUnwrap(PaymentDiscovery.payments(from: [mail("b", "Transaction ID: PAY-501\nAmount paid: CAD 20")], mailbox: account).first)
        XCTAssertEqual(original.id, changed.id)
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PaymentStore(defaults: defaults)
        XCTAssertEqual(try store.merge([original], mailbox: account), [original])
        XCTAssertTrue(try store.merge([changed], mailbox: account).isEmpty)
        let review = try XCTUnwrap(store.paymentReviews(mailbox: account).first)
        XCTAssertEqual(review.reason, .conflictingReceipt)
        XCTAssertEqual(Set(review.options.compactMap(\.currency)), ["USD", "CAD"])
        let keep = try XCTUnwrap(review.options.first { $0.currency == "USD" })
        XCTAssertThrowsError(try store.confirmPaymentReview(review, optionID: keep.id, mailbox: "other@example.invalid"))
        XCTAssertEqual(try store.confirmPaymentReview(review, optionID: keep.id, mailbox: account), [original])
        XCTAssertEqual(try store.merge([original, changed], mailbox: account), [original])
        XCTAssertTrue(try store.paymentReviews(mailbox: account).isEmpty)
        let third = RecordedPayment(id: original.id, service: original.service, amount: 30,
                                    currency: "USD", day: original.day, dateSource: original.dateSource)
        XCTAssertTrue(try store.merge([third], mailbox: account).isEmpty)
        XCTAssertEqual(try store.paymentReviews(mailbox: account).first?.reason, .conflictingReceipt)
        XCTAssertThrowsError(try store.confirmPaymentReview(review, optionID: keep.id, mailbox: account))
    }

    func testUnverifiedAmountCanBeConfirmedOrExcludedWithoutRepeatPrompts() throws {
        let unverified = MailScanMessage(id: "independent", subject: "Studio subscription receipt",
            sender: "Studio <billing@studio.example>", body: "Service: Studio\nMonthly subscription\nAmount paid: $18",
            receivedAt: received)
        let result = PaymentDiscovery.scan(from: [unverified], mailbox: account)
        let review = try XCTUnwrap(result.paymentReviews.first)
        let option = try XCTUnwrap(review.options.first)
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PaymentStore(defaults: defaults)
        _ = try store.merge([], paymentReviews: [review], mailbox: account)
        XCTAssertThrowsError(try store.confirmPaymentReview(review, optionID: option.id, mailbox: account))
        let accepted = try store.confirmPaymentReview(review, optionID: option.id, currency: "cad", mailbox: account)
        XCTAssertEqual(accepted.first?.currency, "CAD")
        XCTAssertEqual(try store.merge([], paymentReviews: [review], mailbox: account), accepted)
        _ = try store.exclude(accepted[0], mailbox: account)
        XCTAssertTrue(try store.merge([], paymentReviews: [review], mailbox: account).isEmpty)
        XCTAssertTrue(try store.paymentReviews(mailbox: account).isEmpty)
    }

    func testConflictAgainstPriorCurrencyReviewIsNotSilentlyResolved() throws {
        let bare = PaymentDiscovery.scan(from: [mail("a", "Transaction ID: PAY-611\nAmount paid: $18")], mailbox: account)
        let changed = PaymentDiscovery.scan(from: [mail("b", "Transaction ID: PAY-611\nAmount paid: USD 25")], mailbox: account)
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PaymentStore(defaults: defaults)
        _ = try store.merge([], reviews: bare.currencyReviews, mailbox: account)
        XCTAssertTrue(try store.merge(changed.payments, mailbox: account).isEmpty)
        XCTAssertTrue(try store.currencyReviews(mailbox: account).isEmpty)
        let conflict = try XCTUnwrap(store.paymentReviews(mailbox: account).first)
        XCTAssertEqual(conflict.options.count, 2)
        XCTAssertEqual(conflict.reason, .conflictingReceipt)
        _ = try store.dismissPaymentReview(conflict, mailbox: account)
        XCTAssertTrue(try store.merge(changed.payments, reviews: bare.currencyReviews, mailbox: account).isEmpty)
        XCTAssertTrue(try store.paymentReviews(mailbox: account).isEmpty)
    }

}
