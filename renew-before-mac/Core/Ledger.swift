import Foundation

enum Cadence: String, Codable, CaseIterable {
    case monthly, annual
}

enum SubscriptionStatus: String, CaseIterable {
    case active, notRenewing, canceled
}

struct Subscription: Codable, Identifiable, Equatable {
    var id = UUID()
    var name = ""
    var amount: Decimal? = nil
    var currency = ""
    var cadence: Cadence? = nil
    // Calendar days are stored at midnight UTC. Only verifiedAt is an instant in time.
    var nextBilling: Date? = nil
    var accessEnds: Date? = nil
    var started: Date? = nil
    var verifiedAt = Date()
    var evidence = ""
    var reminderDays: Int? = nil
    var renewing = true {
        didSet { if renewing { cancellationConfirmed = nil; renewalOffConfirmedAt = nil } }
    }
    // Existing files only recorded auto-renew on/off. Off alone does not prove cancellation.
    var cancellationConfirmed: Bool? = nil
    // A status confirmation does not re-verify the saved price or billing date.
    var renewalOffConfirmedAt: Date? = nil
    var receiptID: String? = nil
    var receiptHistory: [String]? = nil
    // User intent is optional so existing ledgers decode without inventing new facts.
    var purpose: String? = nil
    var needsUntil: Date? = nil
    var reviewOn: Date? = nil
    var isEssential: Bool? = nil
    // A verified civil cutoff. Reviews occur before this date begins locally.
    var cancelBy: Date? = nil
    var reviewedDecisionKey: String? = nil
    var decisionReviewedAt: Date? = nil
    var billingChannel: String? = nil

    var status: SubscriptionStatus {
        get { renewing ? .active : (cancellationConfirmed == true ? .canceled : .notRenewing) }
        set {
            renewing = newValue == .active
            cancellationConfirmed = newValue == .canceled ? true : nil
        }
    }
}

enum Day {
    private static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private static var local: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        return calendar
    }

    static func fromLocal(_ date: Date) -> Date {
        utc.date(from: local.dateComponents([.year, .month, .day], from: date))!
    }

    static func toLocal(_ day: Date) -> Date {
        local.date(from: utc.dateComponents([.year, .month, .day], from: day))!
    }

    static func label(_ day: Date) -> String {
        let parts = utc.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    static func parse(_ text: String) -> Date? {
        guard text.utf8.count == 10 else { return nil }
        let numbers = text.split(separator: "-", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard numbers.count == 3, numbers[0] > 0 else { return nil }
        let parts = DateComponents(year: numbers[0], month: numbers[1], day: numbers[2])
        guard let date = utc.date(from: parts), label(date) == text else { return nil }
        return date
    }
}

struct SpendingSummary {
    let monthlyByCurrency: [String: Decimal]
    let annualByCurrency: [String: Decimal]
    let excludedActiveCount: Int
}

enum Ledger {
    private static let currencyCodes = Set(Locale.commonISOCurrencyCodes)

    static func isCurrency(_ code: String) -> Bool {
        currencyCodes.contains(code)
    }

    static func validate(_ item: Subscription) -> String? {
        if item.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n.text("Enter a service name.")
        }
        if let amount = item.amount, amount.isNaN || amount < 0 {
            return L10n.text("Enter an amount of zero or more.")
        }
        if !item.currency.isEmpty && !isCurrency(item.currency) {
            return L10n.text("Enter a currency code such as USD, EUR, or TWD.")
        }
        if let days = item.reminderDays, !(0...365).contains(days) {
            return L10n.text("Choose a reminder between 0 and 365 days before renewal.")
        }
        if (item.purpose?.count ?? 0) > 500 { return L10n.text("Keep the purpose within 500 characters.") }
        if let channel = item.billingChannel, !["website", "apple", "googlePlay"].contains(channel) {
            return L10n.text("Choose a supported purchase channel.")
        }
        return nil
    }

    static func spendingSummary(_ items: [Subscription]) -> SpendingSummary {
        var fees: [String: (monthly: Decimal, annual: Decimal)] = [:]
        var excluded = 0
        for item in items where item.status == .active {
            guard let amount = item.amount, !amount.isNaN, amount >= 0,
                  isCurrency(item.currency), let cadence = item.cadence else {
                excluded += 1
                continue
            }
            switch cadence {
            case .monthly: fees[item.currency, default: (0, 0)].monthly += amount
            case .annual: fees[item.currency, default: (0, 0)].annual += amount
            }
        }
        return SpendingSummary(monthlyByCurrency: fees.mapValues { $0.monthly + $0.annual / 12 },
                               annualByCurrency: fees.mapValues { $0.monthly * 12 + $0.annual },
                               excludedActiveCount: excluded)
    }

    static func monthlyTotals(_ items: [Subscription]) -> [String: Decimal] {
        spendingSummary(items).monthlyByCurrency
    }

    static func displayMoney(_ amount: Decimal?, _ currency: String) -> String {
        guard let amount else { return L10n.text("Price unknown") }
        let number = NSDecimalNumber(decimal: amount)
        guard isCurrency(currency) else { return L10n.format("%@ · currency unknown", number.stringValue) }
        let formatter = NumberFormatter()
        formatter.locale = L10n.locale
        formatter.numberStyle = .currencyISOCode
        formatter.currencyCode = currency
        return formatter.string(from: number) ?? "\(currency) \(number.stringValue)"
    }
}
