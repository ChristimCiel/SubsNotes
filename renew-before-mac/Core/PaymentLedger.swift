import CryptoKit
import Foundation

enum PaymentDateSource: String, Codable {
    case paymentDate, emailDate, manual

    var label: String {
        switch self {
        case .paymentDate: return "Payment date on receipt"
        case .emailDate: return "Email date · payment date unavailable"
        case .manual: return "Entered by you"
        }
    }
}

struct RecordedPayment: Codable, Identifiable, Equatable {
    let id: String
    let service: String
    let amount: Decimal
    let currency: String
    let day: Date
    let dateSource: PaymentDateSource
}

/// A settled dollar amount stays outside financial totals until its currency is known.
struct PaymentCurrencyReview: Codable, Identifiable, Equatable {
    let id: String
    let service: String
    let amount: Decimal
    let day: Date
    let dateSource: PaymentDateSource

    func payment(currency: String) -> RecordedPayment {
        RecordedPayment(id: id, service: service, amount: amount, currency: currency,
                        day: day, dateSource: dateSource)
    }
}

enum PaymentReviewReason: String, Codable {
    case unverifiedMerchant, conflictingReceipt

    var label: String {
        switch self {
        case .unverifiedMerchant: return "Verify the merchant"
        case .conflictingReceipt: return "Conflicting receipt amounts"
        }
    }
}

struct PaymentReviewOption: Codable, Identifiable, Equatable {
    let service: String
    let amount: Decimal
    let currency: String?
    let day: Date
    let dateSource: PaymentDateSource

    var id: String {
        PaymentStore.digest([service, NSDecimalNumber(decimal: amount).stringValue,
                             currency ?? "", Day.label(day)].joined(separator: "|"))
    }

    init(_ payment: RecordedPayment) {
        service = payment.service
        amount = payment.amount
        currency = payment.currency
        day = payment.day
        dateSource = payment.dateSource
    }

    init(_ review: PaymentCurrencyReview, currency: String?) {
        service = review.service
        amount = review.amount
        self.currency = currency
        day = review.day
        dateSource = review.dateSource
    }

    func payment(id: String, currency: String) -> RecordedPayment {
        RecordedPayment(id: id, service: service, amount: amount, currency: currency,
                        day: day, dateSource: dateSource)
    }
}

struct PaymentReview: Codable, Identifiable, Equatable {
    let id: String
    let reason: PaymentReviewReason
    let options: [PaymentReviewOption]
}

enum PaymentPeriod: String, CaseIterable {
    case last30, last90, all

    var label: String {
        switch self {
        case .last30: return "Last 30 days"
        case .last90: return "Last 90 days"
        case .all: return "All recorded"
        }
    }
}

struct ServiceSpending: Identifiable {
    var id: String { service }
    let service: String
    let totals: [String: Decimal]
}

struct PaymentSummary {
    let payments: [RecordedPayment]
    let totals: [String: Decimal]
    let byService: [ServiceSpending]

    init(payments: [RecordedPayment], period: PaymentPeriod, now: Date = Date()) {
        let today = Day.fromLocal(now)
        // The stored values are civil days at UTC midnight, including across DST.
        let start: Date
        switch period {
        case .last30: start = today.addingTimeInterval(-29 * 86_400)
        case .last90: start = today.addingTimeInterval(-89 * 86_400)
        case .all: start = .distantPast
        }
        self.payments = payments.filter { (start...today).contains($0.day) }.sorted {
            $0.day == $1.day ? $0.id < $1.id : $0.day > $1.day
        }
        var sums = [String: Decimal]()
        var services = [String: [String: Decimal]]()
        var labels = [String: String]()
        for payment in self.payments {
            let key = payment.service.lowercased()
            labels[key] = labels[key] ?? payment.service
            sums[payment.currency, default: 0] += payment.amount
            services[key, default: [:]][payment.currency, default: 0] += payment.amount
        }
        totals = sums
        byService = services.map { ServiceSpending(service: labels[$0.key] ?? $0.key, totals: $0.value) }
            .sorted { $0.service.localizedStandardCompare($1.service) == .orderedAscending }
    }
}

/// Accessed by the app's main-actor scan controller. Evidence is merged atomically.
/// Quarantined records remain stored but stay outside totals until explicitly reviewed.
struct PaymentStore {
    let defaults: UserDefaults
    private struct Snapshot: Codable {
        var records: [RecordedPayment] = []
        var excluded = Set<String>()
        var reviews: [PaymentCurrencyReview]?
        var paymentReviews: [PaymentReview]?
        var resolvedOptions: [String: [String]]?
    }

    private func key(_ mailbox: String) -> String {
        let address = mailbox.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "ledger.payments.v1." + Self.digest(address)
    }

    static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func read(_ mailbox: String) throws -> Snapshot {
        let key = key(mailbox)
        guard let value = defaults.object(forKey: key) else { return Snapshot() }
        guard let data = value as? Data else { throw RecordError("Could not read saved payments.") }
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    private func write(_ snapshot: Snapshot, mailbox: String) throws {
        defaults.set(try JSONEncoder().encode(snapshot), forKey: key(mailbox))
    }

    private func visible(_ snapshot: Snapshot) -> [RecordedPayment] {
        let pending = Set((snapshot.paymentReviews ?? []).map(\.id))
        return snapshot.records.filter { !pending.contains($0.id) }
    }

    func load(mailbox: String) throws -> [RecordedPayment] { visible(try read(mailbox)) }

    func currencyReviews(mailbox: String) throws -> [PaymentCurrencyReview] {
        try read(mailbox).reviews ?? []
    }

    func paymentReviews(mailbox: String) throws -> [PaymentReview] {
        try read(mailbox).paymentReviews ?? []
    }

    private func sameCharge(_ a: PaymentReviewOption, _ b: PaymentReviewOption) -> Bool {
        a.amount == b.amount && (a.currency == nil || b.currency == nil || a.currency == b.currency)
    }

    private func check(_ option: PaymentReviewOption) throws {
        guard !option.service.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !option.amount.isNaN, option.amount > 0,
              option.currency.map(Ledger.isCurrency) ?? true else {
            throw RecordError("Enter a service, a positive payment amount and an ISO currency code.")
        }
    }

    private func quarantine(_ review: PaymentReview, snapshot: inout Snapshot) {
        var options = review.options
        if let prior = snapshot.paymentReviews?.first(where: { $0.id == review.id }) {
            options += prior.options
        }
        if let existing = snapshot.records.first(where: { $0.id == review.id }) {
            options.append(PaymentReviewOption(existing))
        }
        if let existing = snapshot.reviews?.first(where: { $0.id == review.id }) {
            options.append(PaymentReviewOption(existing, currency: nil))
        }
        var seen = Set<String>()
        options = options.filter { seen.insert($0.id).inserted }.sorted { $0.id < $1.id }
        let reason: PaymentReviewReason = options.contains { a in options.contains { !sameCharge(a, $0) } }
            ? .conflictingReceipt : review.reason
        snapshot.paymentReviews = (snapshot.paymentReviews ?? []).filter { $0.id != review.id } + [
            PaymentReview(id: review.id, reason: reason, options: options)
        ]
        snapshot.reviews?.removeAll { $0.id == review.id }
    }

    func merge(_ incoming: [RecordedPayment], reviews: [PaymentCurrencyReview] = [],
               paymentReviews: [PaymentReview] = [], mailbox: String) throws -> [RecordedPayment] {
        var snapshot = try read(mailbox)
        for review in paymentReviews where !snapshot.excluded.contains(review.id) {
            for option in review.options { try check(option) }
            let resolved = Set(snapshot.resolvedOptions?[review.id] ?? [])
            if !review.options.allSatisfy({ resolved.contains($0.id) }) {
                quarantine(review, snapshot: &snapshot)
            }
        }
        for payment in incoming where !snapshot.excluded.contains(payment.id) {
            let option = PaymentReviewOption(payment)
            try check(option)
            if snapshot.resolvedOptions?[payment.id]?.contains(option.id) == true { continue }
            if let existing = snapshot.records.first(where: { $0.id == payment.id }) {
                if !sameCharge(PaymentReviewOption(existing), option) {
                    quarantine(PaymentReview(id: payment.id, reason: .conflictingReceipt, options: [option]), snapshot: &snapshot)
                }
            } else if snapshot.paymentReviews?.contains(where: { $0.id == payment.id }) == true {
                quarantine(PaymentReview(id: payment.id, reason: .unverifiedMerchant, options: [option]), snapshot: &snapshot)
            } else if let existing = snapshot.reviews?.first(where: { $0.id == payment.id }), existing.amount != payment.amount {
                quarantine(PaymentReview(id: payment.id, reason: .conflictingReceipt, options: [option]), snapshot: &snapshot)
            } else {
                snapshot.records.append(payment)
                snapshot.reviews?.removeAll { $0.id == payment.id }
            }
        }
        for review in reviews where !snapshot.excluded.contains(review.id) {
            let option = PaymentReviewOption(review, currency: nil)
            try check(option)
            if snapshot.resolvedOptions?[review.id]?.contains(option.id) == true { continue }
            if let existing = snapshot.records.first(where: { $0.id == review.id }) {
                if existing.amount != review.amount {
                    quarantine(PaymentReview(id: review.id, reason: .conflictingReceipt, options: [option]), snapshot: &snapshot)
                }
            } else if snapshot.paymentReviews?.contains(where: { $0.id == review.id }) == true {
                quarantine(PaymentReview(id: review.id, reason: .unverifiedMerchant, options: [option]), snapshot: &snapshot)
            } else if let existing = snapshot.reviews?.first(where: { $0.id == review.id }) {
                if existing.amount != review.amount {
                    quarantine(PaymentReview(id: review.id, reason: .conflictingReceipt, options: [option]), snapshot: &snapshot)
                }
            } else {
                snapshot.reviews = (snapshot.reviews ?? []) + [review]
            }
        }
        snapshot.reviews?.sort { $0.day == $1.day ? $0.id < $1.id : $0.day > $1.day }
        snapshot.paymentReviews?.sort { $0.id < $1.id }
        try write(snapshot, mailbox: mailbox)
        return visible(snapshot)
    }

    func exclude(_ payment: RecordedPayment, mailbox: String) throws -> [RecordedPayment] {
        var snapshot = try read(mailbox)
        snapshot.records.removeAll { $0.id == payment.id }
        snapshot.reviews?.removeAll { $0.id == payment.id }
        snapshot.paymentReviews?.removeAll { $0.id == payment.id }
        snapshot.excluded.insert(payment.id)
        try write(snapshot, mailbox: mailbox)
        return visible(snapshot)
    }

    func confirmCurrency(_ review: PaymentCurrencyReview, currency: String, mailbox: String) throws -> [RecordedPayment] {
        var snapshot = try read(mailbox)
        if snapshot.records.contains(where: { $0.id == review.id }) { return visible(snapshot) }
        guard let saved = snapshot.reviews?.first(where: { $0.id == review.id }), saved == review else {
            throw RecordError("This receipt is no longer waiting for a currency.")
        }
        let code = currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Ledger.isCurrency(code) else { throw RecordError("Enter a currency code such as USD, CAD, or TWD.") }
        let payment = saved.payment(currency: code)
        snapshot.records.append(payment)
        snapshot.reviews?.removeAll { $0.id == review.id }
        snapshot.resolvedOptions = snapshot.resolvedOptions ?? [:]
        snapshot.resolvedOptions?[review.id] = [PaymentReviewOption(saved, currency: nil).id, PaymentReviewOption(payment).id]
        try write(snapshot, mailbox: mailbox)
        return visible(snapshot)
    }

    func confirmPaymentReview(_ review: PaymentReview, optionID: String, currency: String? = nil,
                              mailbox: String) throws -> [RecordedPayment] {
        var snapshot = try read(mailbox)
        guard let saved = snapshot.paymentReviews?.first(where: { $0.id == review.id }), saved == review,
              let option = saved.options.first(where: { $0.id == optionID }) else {
            throw RecordError("This receipt changed. Reopen the review before confirming it.")
        }
        let code = (option.currency ?? currency ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Ledger.isCurrency(code) else { throw RecordError("Enter a currency code such as USD, CAD, or TWD.") }
        let payment = option.payment(id: review.id, currency: code)
        snapshot.records.removeAll { $0.id == review.id }
        snapshot.records.append(payment)
        snapshot.paymentReviews?.removeAll { $0.id == review.id }
        snapshot.resolvedOptions = snapshot.resolvedOptions ?? [:]
        let oldOptions = snapshot.resolvedOptions?[review.id] ?? []
        snapshot.resolvedOptions?[review.id] = Array(Set(oldOptions + saved.options.map(\.id) + [PaymentReviewOption(payment).id]))
        try write(snapshot, mailbox: mailbox)
        return visible(snapshot)
    }

    func dismissPaymentReview(_ review: PaymentReview, mailbox: String) throws -> [PaymentReview] {
        var snapshot = try read(mailbox)
        guard snapshot.paymentReviews?.contains(review) == true else {
            throw RecordError("This receipt changed. Reopen the review before dismissing it.")
        }
        snapshot.records.removeAll { $0.id == review.id }
        snapshot.paymentReviews?.removeAll { $0.id == review.id }
        snapshot.excluded.insert(review.id)
        try write(snapshot, mailbox: mailbox)
        return snapshot.paymentReviews ?? []
    }

    func dismissCurrencyReview(_ review: PaymentCurrencyReview, mailbox: String) throws -> [PaymentCurrencyReview] {
        var snapshot = try read(mailbox)
        guard snapshot.reviews?.contains(where: { $0.id == review.id }) == true else { return snapshot.reviews ?? [] }
        snapshot.reviews?.removeAll { $0.id == review.id }
        snapshot.excluded.insert(review.id)
        try write(snapshot, mailbox: mailbox)
        return snapshot.reviews ?? []
    }
}
