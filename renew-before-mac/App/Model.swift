import Foundation
import AppKit
import Combine
import WidgetKit

@MainActor final class AppModel: ObservableObject {
    @Published private(set) var items: [Subscription] = []
    @Published var notice: String?
    @Published var requestedSubscriptionID: UUID?
    @Published private(set) var permissionText = "Checking…"
    private let reminders = Reminders()
    private var observers = Set<AnyCancellable>()
    private var refreshGeneration = 0

    init() {
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            NSWorkspace.shared.notificationCenter.publisher(for: name)
                .receive(on: DispatchQueue.main).sink { [weak self] _ in self?.refresh(); WidgetCenter.shared.reloadTimelines(ofKind: "RenewBeforeWidget") }.store(in: &observers)
        }
        for name in [NSNotification.Name.NSSystemTimeZoneDidChange, .NSCalendarDayChanged] {
            NotificationCenter.default.publisher(for: name)
                .receive(on: DispatchQueue.main).sink { [weak self] _ in self?.refresh(); WidgetCenter.shared.reloadTimelines(ofKind: "RenewBeforeWidget") }.store(in: &observers)
        }
        refresh()
    }

    private func store() throws -> RecordStore { RecordStore(url: try StoragePaths.recordsURL()) }

    func refresh() {
        do { items = try store().load(); syncReminders() }
        catch { notice = L10n.format("Cannot read the local records. Nothing was overwritten. %@", error.localizedDescription) }
    }
    private func changed(_ newItems: [Subscription]) {
        items = newItems
        WidgetCenter.shared.reloadTimelines(ofKind: "RenewBeforeWidget")
        syncReminders()
    }
    private func syncReminders() {
        refreshGeneration += 1
        let generation = refreshGeneration, snapshot = items
        Task {
            let result = await reminders.update(snapshot)
            guard generation == refreshGeneration else { return }
            permissionText = result.label
            if let issue = result.issue { notice = issue }
        }
    }
    func save(_ item: Subscription, verify: Bool) throws {
        changed(try store().save(item, verify: verify))
    }
    func updateIntent(_ item: Subscription) throws {
        changed(try store().save(item, verify: false))
    }
    func acknowledgeDecision(_ item: Subscription, key: String) throws {
        var updated = item
        updated.reviewedDecisionKey = key
        updated.decisionReviewedAt = Date()
        try updateIntent(updated)
    }
    func remove(_ id: UUID) throws { changed(try store().remove(id)) }

    private func current(_ id: UUID) throws -> Subscription {
        guard let item = try store().load().first(where: { $0.id == id }) else {
            throw RecordError("This subscription is no longer in your list.")
        }
        return item
    }

    func keepSubscription(_ id: UUID) throws {
        try updateIntent(SubscriptionActions.keeping(current(id)))
    }

    func remindSubscription(_ id: UUID, on day: Date) async throws -> ReminderPlan {
        let updated = try SubscriptionActions.reminding(current(id), on: day)
        guard let plan = ReminderPlan.make(updated, now: Date()) else {
            throw RecordError("Check the billing date before setting this reminder.")
        }
        try updateIntent(updated)
        let status = await reminders.update(items)
        permissionText = status.label
        if let issue = status.issue { notice = issue }
        return plan
    }

    func confirmRenewalOff(_ id: UUID) throws {
        changed(try store().confirmRenewalOff(id))
    }

    func enableNotifications() async {
        do {
            let granted = try await reminders.ask()
            if !granted { notice = L10n.text("Notifications are off. To enable them, open System Settings → Notifications → Renew Before.") }
            refresh()
        } catch { notice = L10n.format("Unable to request notification permission: %@", error.localizedDescription) }
    }
    func testNotification() async {
        do {
            try await reminders.test()
            notice = L10n.text("Test scheduled for 5 seconds from now. Check Notification Center if no banner appears.")
        } catch { notice = error.localizedDescription }
    }
    func importReceipt(_ url: URL) throws -> ReceiptDraft {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let length = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let length, length <= ReceiptParser.maxBytes else { throw RecordError("This receipt exceeds the import size limit.") }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return try checkedDraft(ReceiptParser.parse(data, filename: url.lastPathComponent))
    }
    func importReceiptText(_ text: String) throws -> ReceiptDraft {
        try checkedDraft(ReceiptParser.parse(Data(text.utf8), filename: "pasted.txt"))
    }
    private func checkedDraft(_ draft: ReceiptDraft) throws -> ReceiptDraft {
        guard !items.contains(where: { $0.receiptID == draft.receiptID || $0.receiptHistory?.contains(draft.receiptID) == true }) else {
            throw RecordError("This receipt has already been imported. Open the existing subscription to make changes.")
        }
        return draft
    }
}
