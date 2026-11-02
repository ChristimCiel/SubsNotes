import AppKit
import Foundation
import Security
import SwiftUI

/// Compile with run-decisions-check.sh, which replaces only the entry point and storage path.
/// The production views, controller, model and core all run in an isolated, uniquely named bundle.
enum StoragePaths {
    static func recordsURL() throws -> URL {
        guard CommandLine.arguments.count >= 2,
              Bundle.main.bundleIdentifier?.hasPrefix("org.renewbefore.qa.decisions.") == true else {
            preconditionFailure("Use the isolated Decisions QA runner.")
        }
        return URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("records.json")
    }
}

@main private enum DecisionsFlowCheck {
    @MainActor static func main() {
        precondition(Bundle.main.bundleIdentifier?.hasPrefix("org.renewbefore.qa.decisions.") == true)
        SecKeychainSetUserInteractionAllowed(false)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = CheckDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor private final class CheckDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            do {
                try await check()
                print("PASS Decisions native flow, legacy restore, intent/keep/reschedule, receipt update, renewal-off, restart and actual view renders")
                if CommandLine.arguments.contains("--interactive"), let window {
                    window.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                    print("READY interactive fictional QA window. Ledger \(try StoragePaths.recordsURL().path)")
                    fflush(stdout)
                } else { NSApp.terminate(nil) }
            } catch {
                fputs("Decisions flow failed: \(error)\n", stderr)
                exit(1)
            }
        }
    }

    private func check() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1])
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let today = Day.fromLocal(Date())
        func date(_ offset: Int) -> Date { today.addingTimeInterval(Double(offset) * 86_400) }
        let identifier = UUID()
        let oldVerified = Date().addingTimeInterval(-20 * 86_400)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let iso = ISO8601DateFormatter()
        let legacy: [[String: Any]] = [["id": identifier.uuidString, "name": "Suno", "amount": 12,
                                       "currency": "USD", "cadence": "monthly",
                                       "verifiedAt": iso.string(from: oldVerified),
                                       "evidence": "Fictional source", "renewing": true,
                                       "nextBilling": iso.string(from: date(30)), "reminderDays": 3]]
        try JSONSerialization.data(withJSONObject: legacy).write(to: StoragePaths.recordsURL(), options: .atomic)
        let model = AppModel()
        precondition(model.items.count == 1 && model.items[0].purpose == nil)
        var suno = model.items[0]
        let verified = suno.verifiedAt
        suno.purpose = "Music for a short documentary and a client launch presentation with a long descriptive project name"
        suno.needsUntil = date(12)
        suno.billingChannel = "website"
        // Purchase channel is a billing fact and requires an explicit owner verification.
        do { try model.updateIntent(suno); preconditionFailure("Unverified billing change was accepted") }
        catch is RecordError {}
        suno.billingChannel = nil
        try model.updateIntent(suno)
        precondition(model.items[0].verifiedAt == verified)
        let review = DecisionPlan.make(model.items[0])
        precondition(review.dueOn == date(12) && review.kind == .project)
        precondition(ReminderPlan.make(model.items[0], now: Date())?.subscriptionID == identifier)
        try model.acknowledgeDecision(model.items[0], key: review.key)
        let restored = AppModel()
        precondition(restored.items[0].verifiedAt == verified)
        precondition(!DecisionPlan.make(restored.items[0]).needsReview)
        precondition(ReminderPlan.make(restored.items[0], now: Date()) == nil)
        var moved = restored.items[0]
        moved.reviewOn = date(40)
        try restored.updateIntent(moved)
        let rescheduled = DecisionPlan.make(restored.items[0])
        precondition(rescheduled.needsReview && rescheduled.dueOn == date(27))
        precondition(restored.items[0].verifiedAt == verified)

        // Exercise production text receipt -> existing plan update -> history/fingerprint restore.
        let receipt = try restored.importReceiptText("""
        Service: Suno
        Recurring amount: USD 15
        Billing cycle: Monthly
        Next billing date: \(Day.label(date(30)))
        """)
        var updated = restored.items[0]
        updated.amount = receipt.amount
        updated.receiptID = receipt.receiptID
        updated.billingChannel = "website"
        try restored.save(updated, verify: true)
        precondition(restored.items.count == 1 && restored.items[0].amount == 15)
        do { _ = try restored.importReceiptText("""
        Service: Suno
        Recurring amount: USD 15
        Billing cycle: Monthly
        Next billing date: \(Day.label(date(30)))
        """); preconditionFailure("Duplicate receipt was accepted") }
        catch is RecordError {}

        let payment = RecordedPayment(id: "fictional-paid-1", service: "Suno", amount: 12, currency: "USD",
                                      day: today, dateSource: .manual)
        let store = PaymentStore(defaults: .standard)
        _ = try store.merge([payment], mailbox: "")
        updated = restored.items[0]
        updated.status = .canceled
        updated.accessEnds = date(30)
        try restored.save(updated, verify: true)
        let canceled = AppModel()
        precondition(canceled.items[0].status == .canceled)
        precondition(Ledger.monthlyTotals(canceled.items).isEmpty)
        let preservedPayments = try store.load(mailbox: "")
        precondition(preservedPayments.first?.amount == 12)
        precondition(ReminderPlan.make(canceled.items[0], now: Date())?.title == "Suno access is ending")

        // Seed final synthetic screen state with a project, an essential plan, and a stored failure.
        var active = canceled.items[0]
        active.status = .active
        active.needsUntil = date(4)
        active.reviewOn = nil
        active.reviewedDecisionKey = nil
        try canceled.save(active, verify: true)
        var host = Subscription(name: "Cloud host — production and client delivery", amount: 24, currency: "USD", cadence: .monthly,
                                nextBilling: date(8), reminderDays: 3)
        host.isEssential = true
        host.purpose = "Keep our production service online"
        try canceled.save(host, verify: true)
        let mailbox = "fictional@example.invalid"
        UserDefaults.standard.set(mailbox, forKey: "gmail.connected-address")
        let failure = MailScanMessage(id: "fictional-host-failure", subject: "Cloud host payment failed",
                                     sender: "Host <billing@host.example>", body: "Service: Cloud host — production and client delivery\nPayment failed.\nMonthly subscription", receivedAt: Date())
        let findings = MailDiscovery.candidates(from: [failure], mailbox: mailbox)
        precondition(findings.count == 1 && findings[0].kind == .paymentProblem)
        _ = try MailReviewStore(defaults: .standard).update(mailbox: mailbox) {
            $0.merge(findings, at: Date(), summary: MailScanSummary(inspected: 1, limited: false, skipped: 0))
        }
        let unverified = MailScanMessage(id: "fictional-unverified", subject: "Your subscription receipt",
            sender: "Claims <receipts@unrelated.example>", body: "Service: Claude Pro\nMonthly subscription\nAmount paid: USD 19.25", receivedAt: Date())
        let financial = PaymentDiscovery.scan(from: [unverified], mailbox: mailbox)
        let reviewStore = PaymentStore(defaults: .standard)
        _ = try reviewStore.merge(financial.payments, paymentReviews: financial.paymentReviews, mailbox: mailbox)
        let first = RecordedPayment(id: "fictional-conflict", service: "Design library", amount: 65.10,
                                    currency: "USD", day: Day.fromLocal(Date()), dateSource: .paymentDate)
        let correction = RecordedPayment(id: first.id, service: first.service, amount: 12.40,
                                         currency: "USD", day: first.day, dateSource: first.dateSource)
        _ = try reviewStore.merge([first, correction], mailbox: mailbox)
        let visiblePayments = try reviewStore.load(mailbox: mailbox)
        let heldReviews = try reviewStore.paymentReviews(mailbox: mailbox)
        precondition(visiblePayments.isEmpty && heldReviews.count == 2)
        // The simplified UI uses these same production model actions. No provider is called.
        let unchangedVerification = canceled.items.first { $0.id == active.id }!.verifiedAt
        try canceled.keepSubscription(active.id)
        precondition(!DecisionPlan.make(canceled.items.first { $0.id == active.id }!).needsReview)
        let scheduled = try await canceled.remindSubscription(active.id, on: date(2))
        precondition(scheduled.subscriptionID == active.id)
        let restartWithReminder = AppModel()
        precondition(restartWithReminder.items.first { $0.id == active.id }!.reviewOn == date(2))
        precondition(restartWithReminder.items.first { $0.id == active.id }!.verifiedAt == unchangedVerification)
        try restartWithReminder.confirmRenewalOff(active.id)
        let restartWithOff = AppModel()
        precondition(restartWithOff.items.first { $0.id == active.id }!.renewalOffConfirmedAt != nil)
        precondition(Ledger.monthlyTotals(restartWithOff.items)["USD"] == 24)
        let afterSimpleFlows = try store.load(mailbox: "")
        precondition(afterSimpleFlows == preservedPayments)
        try canceled.save(active, verify: true) // Restore only the isolated fictional screen fixture.
        let options = PanelOptions()
        options.shortcut = "⌥⌘R"
        let logoMatch = MailDiscovery.candidates(from: [unverified], mailbox: mailbox).first!
        _ = try MailReviewStore(defaults: .standard).update(mailbox: mailbox) {
            $0.merge([logoMatch], at: Date(), summary: MailScanSummary(inspected: 2, limited: false, skipped: 0))
        }
        _ = try reviewStore.merge([RecordedPayment(id: "fictional-current-suno", service: "Suno", amount: 15,
                                                  currency: "USD", day: today, dateSource: .manual)], mailbox: mailbox)
        let scan = EmailScanController()
        precondition(ServiceLogoCatalog.imageURL(for: "Suno") != nil, "Native app logo resources missing")
        for language in AppLanguage.allCases {
            options.language = language
            try await render(ScanEmailView(scan: scan, model: canceled, candidate: logoMatch)
                                .environment(\.locale, language.locale),
                             size: NSSize(width: 520, height: 600),
                             destination: output.appendingPathComponent("gmail-match-" + language.rawValue + ".png"))
            let chartSummary = PaymentSummary(payments: [
                RecordedPayment(id: "chart-suno", service: "Suno", amount: 12, currency: "USD", day: today, dateSource: .manual),
                RecordedPayment(id: "chart-claude", service: "Claude Pro", amount: 24, currency: "USD", day: today, dateSource: .manual),
                RecordedPayment(id: "chart-custom", service: "自訂工具", amount: 180, currency: "TWD", day: today, dateSource: .manual)
            ], period: .all)
            try await render(SpendingChart(summary: chartSummary).padding(20).environment(\.locale, language.locale),
                             size: NSSize(width: 520, height: 460),
                             destination: output.appendingPathComponent("spending-" + language.rawValue + ".png"))
            for (name, size) in [("decisions-710", NSSize(width: 710, height: 700)),
                                 ("decisions-520", NSSize(width: 520, height: 460))] {
                try await render(LedgerView(model: canceled, options: options), size: size,
                                 destination: output.appendingPathComponent(name + "-" + language.rawValue + ".png"))
            }
            for appearance in [ColorScheme.light, .dark] {
                let gallery = VStack(alignment: .leading, spacing: 14) {
                    Text(L10n.text("Saved plans")).font(.title2.bold())
                    ForEach(["ChatGPT Plus", "Claude Pro", "Anthropic", "Suno", "Cloudflare Registrar", "Vocal Image",
                             "Meshy", "personalityhub.ai", "Lalamove", "EVA AIRWAYS", "Unlisted service", "自訂工具"], id: \.self) { name in
                        HStack(spacing: 12) { ServiceMark(name: name); Text(verbatim: name); Spacer() }
                    }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(appearance == .dark ? Color.black.opacity(0.9) : Color.white)
                    .environment(\.colorScheme, appearance)
                try await render(gallery, size: NSSize(width: 520, height: 700),
                                 destination: output.appendingPathComponent("logos-" + language.rawValue + "-" + (appearance == .dark ? "dark" : "light") + ".png"))
            }
        }
        if CommandLine.arguments.contains("--interactive") {
            options.language = .english
            let host = NSHostingView(rootView: LedgerView(model: canceled, options: options))
            let panel = LedgerWindow(contentSize: NSSize(width: 710, height: 700))
            panel.contentView = host
            window = panel
        }
        print("Screenshots \(output.path)")
    }

    private func render<Content: View>(_ view: Content, size: NSSize, destination: URL) async throws {
        let host = NSHostingView(rootView: view)
        host.sizingOptions = []
        host.frame = NSRect(origin: .zero, size: size)
        let panel = LedgerWindow(contentSize: size)
        panel.contentView = host
        panel.setContentSize(size)
        panel.setFrameOrigin(NSPoint(x: 20, y: 30))
        panel.orderBack(nil)
        window = panel
        try await Task.sleep(for: .milliseconds(350))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw RecordError("Could not capture native Decisions view")
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw RecordError("Could not encode native Decisions PNG")
        }
        try png.write(to: destination)
        precondition(host.bounds.width == size.width && host.bounds.height == size.height)
        precondition(NSApp.keyWindow == nil, "Background QA rendering unexpectedly made a window key")
        panel.orderOut(nil)
    }

}
