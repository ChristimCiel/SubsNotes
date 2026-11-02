import AppKit
import UserNotifications

final class ReminderDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ReminderDelegate()
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .list, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            let raw = response.notification.request.content.userInfo["subscriptionID"] as? String
            let path = raw.flatMap(UUID.init(uuidString:)).map { "/review/" + $0.uuidString } ?? ""
            DispatchQueue.main.async { NSWorkspace.shared.open(URL(string: "renewbefore://open" + path)!) }
        }
        completion()
    }
}

struct ReminderStatus {
    var label: String
    var issue: String? = nil
}

/// Queue reconciliations, including across awaits. A slow earlier refresh must never restore a deleted request.
@MainActor final class Reminders {
    private let center = UNUserNotificationCenter.current()
    private var tail: Task<ReminderStatus, Never>?
    private let journalKey = "scheduledEventFingerprints.v1"

    init() { center.delegate = ReminderDelegate.shared }

    func ask() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound])
    }

    func test() async throws {
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else {
            throw RecordError("Enable notifications first. If permission was denied, open System Settings → Notifications → Renew Before.")
        }
        let content = UNMutableNotificationContent()
        content.title = L10n.text("Renew Before is ready")
        content.body = L10n.text("This is your local test reminder. Click it to open the panel.")
        content.sound = .default
        let request = UNNotificationRequest(identifier: "renewbefore.test", content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false))
        try await center.add(request)
    }

    func update(_ subscriptions: [Subscription]) async -> ReminderStatus {
        let previous = tail
        let task = Task { @MainActor in
            _ = await previous?.value
            return await reconcile(subscriptions)
        }
        tail = task
        return await task.value
    }

    private func reconcile(_ items: [Subscription]) async -> ReminderStatus {
        let now = Date()
        let plans = items.compactMap { ReminderPlan.make($0, now: now) }.sorted { $0.fireAt < $1.fireAt }
        let wanted = Set(plans.map(\.identifier))
        let old = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix("renewbefore.event.") }
        let pending = Dictionary(uniqueKeysWithValues: old.map { ($0.identifier, $0) })
        center.removePendingNotificationRequests(withIdentifiers: old.map(\.identifier).filter { !wanted.contains($0) })
        let defaults = UserDefaults.standard
        var journal = (defaults.dictionary(forKey: journalKey) as? [String:String] ?? [:]).filter { wanted.contains($0.key) }
        defaults.set(journal, forKey: journalKey)

        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .denied: return ReminderStatus(label: L10n.text("Off in System Settings"))
        case .notDetermined: return ReminderStatus(label: L10n.text("Not enabled"))
        case .authorized, .provisional: break
        default: return ReminderStatus(label: L10n.text("Unavailable"))
        }

        var failures = 0
        for plan in plans {
            let oldRequest = pending[plan.identifier]
            // A catch-up previously accepted by macOS must not recur on every launch, even after dismissal.
            if let existing = oldRequest, existing.content.userInfo["fingerprint"] as? String == plan.fingerprint,
               existing.content.title == plan.title, existing.content.body == plan.body { continue }
            if plan.isCatchUp, oldRequest == nil, let accepted = journal[plan.identifier], plan.matchesAcceptedFingerprint(accepted) {
                journal[plan.identifier] = plan.fingerprint
                defaults.set(journal, forKey: journalKey)
                continue
            }
            let content = UNMutableNotificationContent()
            content.title = plan.title; content.body = plan.body; content.sound = .default
            content.userInfo = ["fingerprint": plan.fingerprint, "subscriptionID": plan.subscriptionID.uuidString]
            let trigger: UNNotificationTrigger
            if plan.isCatchUp {
                trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
            } else {
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = .current
                var date = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: plan.fireAt)
                date.timeZone = calendar.timeZone
                trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: false)
            }
            do {
                try await center.add(UNNotificationRequest(identifier: plan.identifier, content: content, trigger: trigger))
                journal[plan.identifier] = plan.fingerprint
                defaults.set(journal, forKey: journalKey)
            } catch {
                failures += 1
                journal.removeValue(forKey: plan.identifier)
                defaults.set(journal, forKey: journalKey)
                // An obsolete schedule is worse than visibly reporting a failure.
                center.removePendingNotificationRequests(withIdentifiers: [plan.identifier])
            }
        }
        let count = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix("renewbefore.event.") }.count
        return ReminderStatus(label: L10n.format("Allowed · %d scheduled", count),
            issue: failures == 0 ? nil : L10n.format("%d reminders could not be scheduled. Reopen the panel to retry.", failures))
    }
}
