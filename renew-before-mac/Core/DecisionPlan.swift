import CryptoKit
import Foundation

enum DecisionKind: String {
    case project, renewal, cancellation, access, verify
}

/// A review is a local decision. Its acknowledgment never changes provider billing.
struct DecisionPlan: Identifiable, Equatable {
    let id: UUID
    let key: String
    let dueOn: Date?
    let eventOn: Date?
    let kind: DecisionKind
    let reason: String
    let actionLabel: String
    let needsReview: Bool
    let isOverdue: Bool

    static func make(_ item: Subscription, now: Date = Date(), timeZone: TimeZone = .current) -> DecisionPlan {
        let lead = item.reminderDays ?? 0
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = utc.date(from: parts)!
        let billingPassed = item.renewing && (item.nextBilling.map { $0 < today } ?? false)
        var candidates: [(due: Date, event: Date, kind: DecisionKind)] = []
        if item.renewing {
            if let date = item.reviewOn ?? item.needsUntil { candidates.append((date, date, .project)) }
            if let bill = item.nextBilling { candidates.append((addingDays(-lead, to: bill), bill, .renewal)) }
            if let cutoff = item.cancelBy {
                candidates.append((addingDays(-max(1, lead), to: cutoff), cutoff, .cancellation))
            }
        } else if let access = item.accessEnds {
            candidates.append((addingDays(-lead, to: access), access, .access))
        }
        let chosen = candidates.sorted {
            if $0.due != $1.due { return $0.due < $1.due }
            return $0.kind.rawValue < $1.kind.rawValue
        }.first
        let kind = billingPassed ? DecisionKind.verify : chosen?.kind ?? .verify
        let dateKey = [item.needsUntil, item.reviewOn, item.nextBilling, item.cancelBy, item.accessEnds]
            .map { $0.map(Day.label) ?? "unknown" }
        let components = [item.id.uuidString, kind.rawValue, item.renewing ? "renewing" : "off",
                          item.amount.map { NSDecimalNumber(decimal: $0).stringValue } ?? "unknown",
                          item.currency, item.cadence?.rawValue ?? "unknown", item.purpose ?? "",
                          item.billingChannel ?? "unknown"] + dateKey
        let key = SHA256.hash(data: Data(components.joined(separator: "\u{1F}").utf8))
            .map { String(format: "%02x", $0) }.joined()
        let overdue = chosen.map { $0.due < today } ?? false
        let reason: String
        switch kind {
        case .project:
            reason = item.purpose.map { L10n.format("Review whether you still need this for %@.", $0) } ?? L10n.text("Your project review is approaching. Decide whether to keep this tool.")
        case .renewal:
            reason = item.cancelBy == nil ? L10n.text("An expected charge is approaching. Confirm the cancellation cutoff before deciding.") : L10n.text("Review this plan before the expected charge.")
        case .cancellation:
            reason = L10n.text("Check this plan before your recorded cancellation date begins.")
        case .access:
            reason = item.isEssential == true ? L10n.text("Access to an essential service is ending. Check whether you need to continue.") : L10n.text("Renewal is off. Review your remaining paid access.")
        case .verify:
            if billingPassed {
                reason = L10n.text("Your recorded billing date has passed. Check the provider for payment and the next confirmed date.")
            } else {
                reason = item.renewing ? L10n.text("Add a review date or confirm the next billing date.") : L10n.text("Renewal is off. Add the access end if you want an expiry reminder.")
            }
        }
        return DecisionPlan(id: item.id, key: key, dueOn: chosen?.due, eventOn: chosen?.event,
                            kind: kind, reason: reason,
                            actionLabel: kind == .verify ? L10n.text("Add a date") : L10n.text("Review decision"),
                            needsReview: kind == .verify || item.reviewedDecisionKey != key,
                            isOverdue: overdue)
    }

    static func sorted(_ items: [Subscription], now: Date = Date(), timeZone: TimeZone = .current) -> [DecisionPlan] {
        items.map { make($0, now: now, timeZone: timeZone) }.sorted {
            if $0.needsReview != $1.needsReview { return $0.needsReview }
            if $0.dueOn != $1.dueOn { return ($0.dueOn ?? .distantFuture) < ($1.dueOn ?? .distantFuture) }
            return $0.id.uuidString < $1.id.uuidString
        }
    }

    private static func addingDays(_ days: Int, to date: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.date(byAdding: .day, value: days, to: date)!
    }
}
