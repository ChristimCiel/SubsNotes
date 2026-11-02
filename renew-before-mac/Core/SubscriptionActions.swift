import Foundation

/// Local choices never call a provider, alter payment history, or manufacture a new billing cycle.
enum SubscriptionActions {
    static func keeping(_ item: Subscription, now: Date = Date()) throws -> Subscription {
        let plan = DecisionPlan.make(item, now: now)
        guard item.renewing, plan.kind != .verify else {
            throw RecordError("Check the next billing date before keeping this renewal.")
        }
        var updated = item
        updated.reviewedDecisionKey = plan.key
        updated.decisionReviewedAt = now
        return updated
    }

    static func reminding(_ item: Subscription, on day: Date, now: Date = Date()) throws -> Subscription {
        guard item.renewing, day > Day.fromLocal(now),
              item.nextBilling.map({ day < $0 }) ?? true,
              item.cancelBy.map({ day < $0 }) ?? true else {
            throw RecordError("Choose a future date before the charge and any cancellation deadline.")
        }
        var updated = item
        updated.reviewOn = day
        updated.reminderDays = 0
        updated.reviewedDecisionKey = nil
        updated.decisionReviewedAt = nil
        return updated
    }

    static func confirmingRenewalOff(_ item: Subscription, now: Date = Date()) -> Subscription {
        var updated = item
        updated.status = .canceled
        updated.renewalOffConfirmedAt = now
        updated.reviewedDecisionKey = nil
        updated.decisionReviewedAt = nil
        return updated
    }

    static func nextToReview(_ items: [Subscription], now: Date = Date()) -> Subscription? {
        let today = Day.fromLocal(now)
        let active = items.filter { $0.renewing && !($0.reminderDays != nil && ($0.reviewOn ?? .distantPast) > today) }
        let plans = DecisionPlan.sorted(active, now: now)
        guard let plan = plans.first(where: \.needsReview) else { return nil }
        return active.first { $0.id == plan.id }
    }
}
