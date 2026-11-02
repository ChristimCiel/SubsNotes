import Foundation

/// One notification for the earliest recorded project, billing or access review.
struct ReminderPlan: Equatable {
    let identifier: String
    let subscriptionID: UUID
    let title: String
    let body: String
    let fireAt: Date
    let eventDay: String
    let isCatchUp: Bool
    let fingerprint: String

    func matchesAcceptedFingerprint(_ stored: String) -> Bool {
        if stored == fingerprint { return true }
        // 0.4 included translated title/body. Preserve its accepted event during upgrade.
        let previous = stored.split(separator: "|", maxSplits: 3, omittingEmptySubsequences: false)
        let current = fingerprint.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
        return previous.count == 4 && current.count == 3 && previous[0] == current[0] && previous[1] == current[1]
    }

    static func make(_ item: Subscription, now: Date, timeZone: TimeZone = .current) -> ReminderPlan? {
        guard let lead = item.reminderDays, (0...365).contains(lead) else { return nil }
        let decision = DecisionPlan.make(item, now: now, timeZone: timeZone)
        guard decision.needsReview, let date = decision.eventOn, let due = decision.dueOn else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        var local = Calendar(identifier: .gregorian)
        local.timeZone = timeZone
        // A past billing/access event stays overdue in the dashboard, never a new paid cycle.
        let expiry = item.renewing ? item.nextBilling : item.accessEnds
        if let expiry {
            let parts = utc.dateComponents([.year, .month, .day], from: expiry)
            guard let civilStart = local.date(from: parts),
                  let afterEvent = local.date(byAdding: .day, value: 1, to: civilStart),
                  now < afterEvent else { return nil }
        }
        let components = utc.dateComponents([.year, .month, .day], from: due)
        guard let reminderDay = local.date(from: components),
              let nine = local.date(bySettingHour: 9, minute: 0, second: 0, of: reminderDay) else { return nil }
        let event: String
        switch decision.kind {
        case .renewal: event = "billing"
        case .access: event = "access"
        default: event = "review"
        }
        let day = Day.label(date)
        let id = "renewbefore.event.\(item.id.uuidString).\(event).\(day)"
        let title: String
        switch decision.kind {
        case .project: title = L10n.format("Review %@ for your project", item.name)
        case .cancellation: title = L10n.format("Review %@ cancellation deadline", item.name)
        default: title = item.renewing ? L10n.format("Review %@ before renewal", item.name) : L10n.format("%@ access is ending", item.name)
        }
        let body: String
        if decision.kind == .project {
            body = L10n.format("%@ Open Renew Before to decide.", decision.reason)
        } else if decision.kind == .cancellation {
            body = L10n.format("Your recorded cancellation date is %@. Check the provider now if this date has passed.", day)
        } else if !item.renewing {
            body = L10n.format("Your recorded access end is %@. Open Renew Before to review it.", day)
        } else if let amount = item.amount, Ledger.isCurrency(item.currency) {
            body = L10n.format("%@ is listed for %@. Open Renew Before to review the charge.", Ledger.displayMoney(amount, item.currency), day)
        } else {
            body = L10n.format("Your next bill is recorded for %@. Open Renew Before to review it.", day)
        }
        return ReminderPlan(identifier: id, subscriptionID: item.id, title: title, body: body,
                            fireAt: nine > now ? nine : now.addingTimeInterval(5),
                            eventDay: day, isCatchUp: nine <= now,
                            fingerprint: "\(id)|\(Int(nine.timeIntervalSince1970))|\(decision.key)")
    }
}
