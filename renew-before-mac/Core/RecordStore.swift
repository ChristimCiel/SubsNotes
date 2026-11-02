import Foundation

struct RecordError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { L10n.text(message) }
}

/// Sole writer is the app. Widget readers always see a complete atomic snapshot.
struct RecordStore {
    let url: URL

    func load() throws -> [Subscription] {
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let records = try decoder.decode([Subscription].self, from: data)
        guard Set(records.map(\.id)).count == records.count else {
            throw RecordError(L10n.text("Duplicate records in the local file. Your data was left untouched."))
        }
        return records
    }

    private func write(_ items: [Subscription]) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(items)
        try bytes.write(to: url, options: .atomic)
        // Directory access is restricted; also protect the final atomic file.
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    @discardableResult func save(_ input: Subscription, verify: Bool, now: Date = Date()) throws -> [Subscription] {
        var records = try load() // Never replace an unreadable file with an empty inventory.
        var item = input
        item.name = item.name.trimmingCharacters(in: .whitespacesAndNewlines)
        item.currency = item.currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        item.evidence = item.evidence.trimmingCharacters(in: .whitespacesAndNewlines)
        item.purpose = item.purpose?.trimmingCharacters(in: .whitespacesAndNewlines)
        if item.purpose?.isEmpty == true { item.purpose = nil }
        if let problem = Ledger.validate(item) { throw RecordError(problem) }
        if let receiptID = item.receiptID, records.contains(where: { ($0.receiptID == receiptID || $0.receiptHistory?.contains(receiptID) == true) && $0.id != item.id }) {
            throw RecordError(L10n.text("This receipt is already linked to a subscription. Edit the existing record instead."))
        }
        if let index = records.firstIndex(where: { $0.id == item.id }) {
            let old = records[index]
            item.verifiedAt = old.verifiedAt
            item.receiptHistory = old.receiptHistory
            var comparable = item
            comparable.reminderDays = old.reminderDays
            comparable.purpose = old.purpose
            comparable.needsUntil = old.needsUntil
            comparable.reviewOn = old.reviewOn
            comparable.isEssential = old.isEssential
            comparable.reviewedDecisionKey = old.reviewedDecisionKey
            comparable.decisionReviewedAt = old.decisionReviewedAt
            if !verify && comparable != old {
                throw RecordError(L10n.text("Confirm the billing details before saving these changes."))
            }
            if verify { item.verifiedAt = now }
            if let oldID = old.receiptID, oldID != item.receiptID {
                item.receiptHistory = Array(Set((old.receiptHistory ?? []) + [oldID])).sorted()
            }
            records[index] = item
        } else {
            guard verify else { throw RecordError(L10n.text("Review and confirm the details before adding this subscription.")) }
            item.verifiedAt = now
            records.append(item)
        }
        try write(records)
        return records
    }

    @discardableResult func remove(_ id: UUID) throws -> [Subscription] {
        var records = try load()
        records.removeAll { $0.id == id }
        try write(records)
        return records
    }

    @discardableResult func confirmRenewalOff(_ id: UUID, now: Date = Date()) throws -> [Subscription] {
        var records = try load()
        guard let index = records.firstIndex(where: { $0.id == id }) else {
            throw RecordError("This subscription is no longer in your list.")
        }
        records[index] = SubscriptionActions.confirmingRenewalOff(records[index], now: now)
        try write(records)
        return records
    }
}
