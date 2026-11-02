import CryptoKit
import Foundation

enum MailEvidenceKind: String, Codable {
    case paymentProblem, cancellation, ending, renewal, receipt

    var label: String {
        switch self {
        case .paymentProblem: return "Payment problem"
        case .cancellation: return "Cancellation notice"
        case .ending: return "Ending or non-renewal notice"
        case .renewal: return "Renewal notice"
        case .receipt: return "Subscription receipt"
        }
    }
}

/// A suggestion backed by the newest matching email. It has no verification date or active status.
struct MailCandidate: Identifiable {
    let id: String
    let name: String
    let kind: MailEvidenceKind
    let subject: String
    let sender: String
    let receivedAt: Date
    var messageCount: Int
    let draft: ReceiptDraft
}

enum MailDiscovery {
    static func candidates(from messages: [MailScanMessage], mailbox: String) -> [MailCandidate] {
        let account = mailbox.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let recentFirst = messages.sorted {
            $0.receivedAt == $1.receivedAt ? $0.id < $1.id : $0.receivedAt > $1.receivedAt
        }
        var seen = Set<String>()
        var grouped: [String: MailCandidate] = [:]
        for message in recentFirst {
            guard let candidate = candidate(from: message, account: account),
                  seen.insert(candidate.draft.receiptID).inserted else { continue }
            if grouped[candidate.id] == nil { grouped[candidate.id] = candidate }
            else { grouped[candidate.id]?.messageCount += 1 }
        }
        return grouped.values.sorted {
            $0.receivedAt == $1.receivedAt ? $0.id < $1.id : $0.receivedAt > $1.receivedAt
        }
    }

    static func candidate(from message: MailScanMessage, account: String) -> MailCandidate? {
        let subject = String(message.subject.prefix(250)).trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = currentMessageLines(message.body)
        let body = lines.joined(separator: "\n")
        let namedPlan = receiptPlan(in: lines)
        guard let kind = classify(subject: subject, body: body, hasLabeledPlan: namedPlan?.labeled == true) else { return nil }
        let fields = billingFields(in: lines)
        let fieldText = fields.isEmpty ? "Billing email" : fields.joined(separator: "\n")
        guard var draft = try? ReceiptParser.parse(Data(fieldText.utf8), filename: "billing.txt"),
              let domain = senderDomain(message.sender),
              let name = serviceName(explicit: draft.name, subject: subject, sender: message.sender, domain: domain) ?? namedPlan?.name
        else { return nil }

        draft.name = name
        // A failed payment or cancellation may quote the previous renewal date.
        if kind == .paymentProblem || kind == .cancellation || kind == .ending { draft.nextBilling = nil }
        let evidence = lines.filter { has(#"\b(?:bill(?:ed|ing)?|renew\w*|subscription|membership|recurring|plan|payment|cancel\w*|access ends|price)\b"#, $0) }
        draft.excerpt = String(([subject] + evidence.prefix(4).map { String($0.prefix(160)) }).joined(separator: "\n").prefix(600))
        let sender = String(message.sender.prefix(250))
        let messageKey = message.id.isEmpty ? body : message.id
        draft.receiptID = digest(["mail", account, sender.lowercased(), subject, messageKey].joined(separator: "\u{1F}"))
        let service = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
        let merchantID = digest([account, domain, service].joined(separator: "\u{1F}"))
        let identity = kind == .paymentProblem ? problemID(draft.receiptID) : merchantID
        return MailCandidate(id: identity, name: name, kind: kind, subject: subject,
                             sender: sender, receivedAt: message.receivedAt, messageCount: 1, draft: draft)
    }

    static func currentMessageLines(_ body: String) -> [String] {
        var lines: [String] = []
        for raw in body.prefix(16_000).split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if has(#"^(?:-+\s*(?:original|forwarded) message|on .+ wrote:)"#, line) { break }
            if line.hasPrefix(">") || has(#"^(?:unsubscribe\b|manage (?:your )?(?:email |marketing )?(?:preferences|subscriptions?)\s*[.|]?$|https?://)"#, line) { continue }
            lines.append(line)
        }
        return lines
    }

    /// An exact plan line can identify a processor receipt. Only an explicit plan field supplies
    /// recurring context on its own; a brand mentioned in passing or an upsell supplies neither.
    private static func receiptPlan(in lines: [String]) -> (name: String, labeled: Bool)? {
        var plans = Set<String>()
        var hasPlanField = false
        var otherItem = false
        for line in lines {
            let label = line.range(of: #"^(?i:plan(?: name)?|product|item|方案(?:名稱)?|商品名稱)\s*[:：]\s*"#, options: .regularExpression)
            let value = label.map { String(line[$0.upperBound...]).trimmingCharacters(in: .whitespaces) } ?? line
            if let plan = MailReceiptTerms.planNames.first(where: { value.caseInsensitiveCompare($0) == .orderedSame }) {
                plans.insert(plan)
                if let label, has(#"^(?:plan|方案)"#, String(line[label])) { hasPlanField = true }
            } else if label != nil { otherItem = true }
        }
        guard plans.count == 1, let name = plans.first, !otherItem else { return nil }
        return (name, hasPlanField)
    }

    private static func classify(subject: String, body: String, hasLabeledPlan: Bool) -> MailEvidenceKind? {
        if has(#"電子報|限時優惠|立即訂閱|訂閱優惠|免費試用優惠"#, subject) { return nil }
        if has(#"^\s*(?:re|fw|fwd):|\b(?:newsletter|special offer|flash sale|subscribe (?:now|and save)|upgrade (?:today|now)|save \d+%|start (?:your |a )?free trial)\b"#, subject) { return nil }
        let factual = body.split(whereSeparator: \.isNewline).filter { line in
            !has(#"^(?:如(?:果|需|欲)|若|假如|如何|如果您想|取消訂閱[。.]?$|if\b|what (?:if|happens)\b|in (?:case|the event)\b|(?:can|how (?:can|do)) I\b|to cancel\b)"#, String(line))
        }
        let text = ([subject] + factual.map(String.init)).joined(separator: "\n")
        if has(#"\b(?:usage[- ]based|pay[- ]as[- ]you[- ]go|metered (?:bill|usage)|transaction fees?|one[- ]time (?:purchase|order|payment|charge))\b"#, text) { return nil }
        let recurring = has(#"\b(?:subscriptions?|memberships?|recurring (?:charge|amount|payment)|billing (?:cycle|frequency|interval)|(?:(?:monthly|annual|yearly) plan)|next (?:billing|renewal|charge) date|auto[- ]renew\w*|renewal|renews)\b"#, text)
        let recurringChinese = has(#"訂閱|會員(?:資格|方案|月費|年費|續費)|自動續(?:訂|約|費)|下次扣款"#, text)
        if has(#"一次性(?:付款|消費|購買)|依(?:使用|用)量計費|交易手續費"#, text) { return nil }
        guard recurring || recurringChinese || hasLabeledPlan || !captures(ratePattern, in: text).isEmpty else { return nil }
        if has(#"(?:訂閱|會員(?:資格|方案)?)(?:服務|方案)?(?:已(?:經|成功)?|遭)取消|已(?:經|成功)?取消(?:您|你)?的?(?:訂閱|會員資格)|訂閱取消確認"#, text) { return .cancellation }
        if has(#"不(?:會|再)(?:自動)?續(?:訂|費|約)|(?:訂閱|會員資格)(?:已到期|即將終止)|自動續(?:訂|約|費)已關閉"#, text) { return .ending }
        if has(#"(?:付款|扣款|續訂|續費)(?:失敗|遭拒)|未能(?:處理付款|扣款)"#, text) { return .paymentProblem }
        if has(#"(?:訂閱|會員資格)(?:即將|將會?)(?:自動)?續(?:訂|費|約)|續訂提醒|下次扣款日"#, text) { return .renewal }
        if has(#"收據|付款成功|付款確認|扣款成功|已付款"#, text) { return .receipt }
        if has(#"\b(?:cancell?ation (?:confirmation|notice)|(?:subscription|membership|plan)(?: (?:has been|has|is|was|successfully))? cancell?ed|(?:you(?:'ve| have)|we(?:'ve| have)) cancell?ed your (?:subscription|membership))\b"#, text) { return .cancellation }
        if has(#"\b(?:(?:subscription|membership|plan)(?: (?:has|is|was))? (?:ended|expired)|(?:subscription|membership|plan) (?:will|is scheduled to) end|will not renew|won['’]t renew|auto[- ]renewal (?:is|was|has been) (?:off|turned off|disabled))\b"#, text) { return .ending }
        if has(#"\b(?:(?:payment|charge|renewal|card)(?: (?:has|was|is))? (?:failed|declined|unsuccessful)|(?:failed|unable) to (?:process|renew|charge|collect)|could(?:n['’]t| not) (?:process|charge|renew)|past due)\b"#, text) { return .paymentProblem }
        if has(#"\b(?:renewal (?:notice|reminder)|renewal (?:is )?(?:upcoming|approaching)|auto[- ]renews?|(?:subscription|membership|plan)(?: will)? renews?|next (?:billing|charge|renewal) date)\b"#, text) { return .renewal }
        if has(#"\b(?:invoice|receipt|payment confirmation|payment (?:was )?(?:received|successful|confirmed)|billing statement|amount paid|recurring (?:charge|amount)|you(?: were|'ve been| have been) charged)\b"#, text) { return .receipt }
        return nil
    }

    private static let ratePattern = #"(?<![A-Za-z0-9.,])((?:(?:[A-Z]{3}\s*|US\$|CA\$|NT\$|€|\$)\d+(?:\.\d+)?|\d+(?:\.\d+)?\s+[A-Z]{3}))\s*(?:/\s*|(?i:per|each|a)\s+)(?i:(month|year))\b"#
    private static let datePattern = #"(?i:\b(?:renews on|will renew on|next (?:billing|renewal|charge) date is)\s+)(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9} \d{1,2}, \d{4}|\d{1,2} [A-Za-z]{3,9} \d{4})\b"#

    private static func billingFields(in lines: [String]) -> [String] {
        var fields: [String] = []
        for line in lines {
            if has(#"\b(?:upgrade (?:today|to|for)|special offer|save \d+%|starting (?:at|from)|plans (?:from|start)|as low as)\b"#, line) { continue }
            // A receipt total can include usage, tax or credits. Accept only the recurring price.
            if has(#"^(?:service(?: name)?|subscription name|product|recurring (?:amount|charge|total)|renewal (?:amount|price|date)|next (?:charge amount|renewal amount|billing(?: date)?|charge date|renewal(?: date)?|payment date)|subscription price|currency(?: code)?|cadence|billing (?:cycle|frequency|interval|period)|billed every)\s*:"#, line) {
                if has(#"^(?:recurring (?:amount|charge|total)|renewal (?:amount|price)|next (?:charge|renewal) amount|subscription price)\s*:"#, line) {
                    fields.append(normalizeCurrencySymbols(line))
                } else {
                    fields.append(line)
                }
            }
            if has(#"\bbilled monthly\b"#, line) { fields.append("Billed monthly") }
            if has(#"\bbilled (?:annually|yearly)\b"#, line) { fields.append("Billed annually") }
            for rate in captures(ratePattern, in: line) {
                let price = normalizeCurrencySymbols(rate[0])
                fields.append("Recurring amount: \(price)/\(rate[1].lowercased())")
            }
            for date in captures(datePattern, in: line) { fields.append("Next billing date: " + date[0]) }
        }
        return fields
    }

    private static func normalizeCurrencySymbols(_ line: String) -> String {
        line.replacingOccurrences(of: "US$", with: "USD ")
            .replacingOccurrences(of: "CA$", with: "CAD ")
            .replacingOccurrences(of: "NT$", with: "TWD ")
            .replacingOccurrences(of: "€", with: "EUR ")
            .replacingOccurrences(of: "$", with: "")
    }

    private static func senderDomain(_ sender: String) -> String? {
        guard var domain = captures(#"@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)"#, in: sender).first?.first?.lowercased() else { return nil }
        let mailPrefixes = ["billing.", "email.", "mail.", "receipts.", "notifications.", "em."]
        while let prefix = mailPrefixes.first(where: { domain.hasPrefix($0) }),
              domain.dropFirst(prefix.count).contains(".") { domain.removeFirst(prefix.count) }
        return domain
    }

    private static func serviceName(explicit: String?, subject: String, sender: String, domain: String) -> String? {
        if let explicit, !explicit.isEmpty, explicit.count <= 80 { return explicit }
        if let merchant = captures(#"(?i)\b(?:receipt|invoice|payment confirmation) from (.{2,80}?)(?:\s+(?:#|\(|\[)|\s+[—|]|$)"#, in: subject).first?.first {
            let name = merchant.trimmingCharacters(in: .whitespacesAndNewlines)
            if !has(#"^(?:apple|app store|google play|stripe|paypal|paddle|lemon squeezy)(?:,? inc\.?)?$"#, name) { return name }
        }
        // A processor may bill many services. Its own display name cannot identify the subscription.
        let relays = ["stripe.com", "paypal.com", "paddle.com", "apple.com", "lemonsqueezy.com", "gmail.com", "outlook.com", "icloud.com", "googlemail.com"]
        guard !relays.contains(where: { domain == $0 || domain.hasSuffix("." + $0) }) else { return nil }
        if let separator = sender.firstIndex(of: "<") {
            let display = String(sender[..<separator]).trimmingCharacters(in: CharacterSet(charactersIn: " \"\t"))
                .replacingOccurrences(of: #"(?i)\s+(?:billing(?: team)?|receipts|notifications|support)$"#, with: "", options: .regularExpression)
            if (2...80).contains(display.count), !has(#"^(?:billing(?: team)?|receipts?|notifications?|customer (?:service|support)|support|team|no[- ]?reply|accounts?)$"#, display) { return display }
        }
        return domain
    }

    private static func has(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func captures(_ pattern: String, in text: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
            (1..<match.numberOfRanges).compactMap { Range(match.range(at: $0), in: text).map { String(text[$0]) } }
        }
    }

    fileprivate static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    fileprivate static func problemID(_ receiptID: String) -> String {
        digest("unresolved-payment|" + receiptID)
    }
}

/// The local review list stores extracted fields. Subjects, senders and excerpts only appear
/// during a live scan, and never become part of the review cache.
private struct StoredMailMatch: Codable {
    let id: String
    let name: String
    let kind: MailEvidenceKind
    let receivedAt: Date
    let messageCount: Int
    let amount: Decimal?
    let currency: String?
    let cadence: Cadence?
    let nextBilling: Date?
    let receiptID: String

    init(_ candidate: MailCandidate) {
        id = candidate.id
        name = candidate.name
        kind = candidate.kind
        receivedAt = candidate.receivedAt
        messageCount = candidate.messageCount
        amount = candidate.draft.amount
        currency = candidate.draft.currency
        cadence = candidate.draft.cadence
        nextBilling = candidate.draft.nextBilling
        receiptID = candidate.draft.receiptID
    }

    var candidate: MailCandidate {
        let draft = ReceiptDraft(name: name, amount: amount, currency: currency, cadence: cadence,
                                 nextBilling: nextBilling, receiptID: receiptID, excerpt: "")
        let identity = kind == .paymentProblem ? MailDiscovery.problemID(receiptID) : id
        return MailCandidate(id: identity, name: name, kind: kind, subject: "", sender: "",
                             receivedAt: receivedAt, messageCount: messageCount, draft: draft)
    }
}

struct MailScanSummary: Codable {
    let inspected: Int
    let limited: Bool
    let skipped: Int
    // nil represents a saved scan performed before the dedicated receipt search was available.
    var additionalReceiptEmails: Int? = nil
    var recordedCount: Int? = nil
    var recordedTotals: [String: Decimal]? = nil
    var unresolvedCurrencyCount: Int? = nil
    var receiptPDFsUsed: Int? = nil

    var limitNote: String {
        guard additionalReceiptEmails != nil else {
            return limited ? "This scan reached its 30-email limit. Older matches may be missing." : ""
        }
        let scope = "Searches cover up to 30 billing notices and 30 additional receipt emails (60 total)."
        return limited ? scope + " At least one search reached its limit; older receipts may be missing." : scope
    }
}

struct MailReviewInbox: Codable {
    private(set) var lastScanAt: Date?
    private(set) var lastScanSummary: MailScanSummary?
    private var matches: [String: StoredMailMatch] = [:]
    private var dismissedThrough: [String: Date] = [:]

    func pending(for items: [Subscription]) -> [MailCandidate] {
        var reviewed = Set(items.compactMap(\.receiptID))
        for item in items { reviewed.formUnion(item.receiptHistory ?? []) }
        return matches.values.filter { $0.kind == .paymentProblem || !reviewed.contains($0.receiptID) }.map(\.candidate).sorted {
            $0.receivedAt == $1.receivedAt ? $0.id < $1.id : $0.receivedAt > $1.receivedAt
        }
    }

    func isDismissed(_ candidate: MailCandidate) -> Bool {
        dismissedThrough[candidate.id].map { $0 >= candidate.receivedAt } ?? false
    }

    mutating func merge(_ findings: [MailCandidate], at date: Date, summary: MailScanSummary) {
        preserveLegacyProblems()
        lastScanAt = date
        lastScanSummary = summary
        for candidate in findings where !isDismissed(candidate) {
            if let stored = matches[candidate.id], stored.receivedAt > candidate.receivedAt { continue }
            matches[candidate.id] = StoredMailMatch(candidate)
        }
    }

    private mutating func preserveLegacyProblems() {
        for (key, match) in Array(matches) where match.kind == .paymentProblem {
            let candidate = match.candidate
            guard key != candidate.id else { continue }
            matches.removeValue(forKey: key)
            matches[candidate.id] = StoredMailMatch(candidate)
        }
    }

    mutating func restoreNewerChanges(from other: MailReviewInbox) {
        if let scanDate = other.lastScanAt, scanDate >= (lastScanAt ?? .distantPast) {
            lastScanAt = scanDate
            lastScanSummary = other.lastScanSummary
        }
        for (id, through) in other.dismissedThrough {
            dismissedThrough[id] = max(dismissedThrough[id] ?? .distantPast, through)
        }
        for (id, item) in other.matches where item.receivedAt >= (matches[id]?.receivedAt ?? .distantPast) {
            matches[id] = item
        }
        preserveLegacyProblems()
        matches = matches.filter { id, item in item.receivedAt > (dismissedThrough[id] ?? .distantPast) }
    }

    mutating func dismiss(_ candidate: MailCandidate) {
        preserveLegacyProblems()
        dismissedThrough[candidate.id] = max(dismissedThrough[candidate.id] ?? .distantPast, candidate.receivedAt)
        if let match = matches[candidate.id], match.receivedAt <= candidate.receivedAt {
            matches.removeValue(forKey: candidate.id)
        }
    }
}

struct MailReviewStore {
    let defaults: UserDefaults

    private func key(_ mailbox: String) -> String {
        "gmail.review.v1." + MailDiscovery.digest(mailbox.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    private func legacyKey(_ mailbox: String) -> String {
        "gmail.review.v1." + mailbox.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func read(_ key: String) throws -> MailReviewInbox? {
        guard let stored = defaults.object(forKey: key) else { return nil }
        guard let data = stored as? Data, let inbox = try? JSONDecoder().decode(MailReviewInbox.self, from: data) else {
            throw RecordError("Couldn’t open the saved Gmail review list on this Mac. The original data was preserved.")
        }
        return inbox
    }

    func load(mailbox: String) throws -> MailReviewInbox {
        let currentKey = key(mailbox), previousKey = legacyKey(mailbox)
        let current = try read(currentKey)
        guard var previous = try read(previousKey) else { return current ?? MailReviewInbox() }
        // A newer build may already have scanned before learning about the previous location.
        if let current { previous.restoreNewerChanges(from: current) }
        defaults.set(try JSONEncoder().encode(previous), forKey: currentKey)
        defaults.removeObject(forKey: previousKey)
        return previous
    }

    func update(mailbox: String, _ edit: (inout MailReviewInbox) -> Void) throws -> MailReviewInbox {
        var inbox = try load(mailbox: mailbox)
        edit(&inbox)
        let data = try JSONEncoder().encode(inbox)
        defaults.set(data, forKey: key(mailbox))
        return inbox
    }

    func forget(mailbox: String) {
        defaults.removeObject(forKey: key(mailbox))
        defaults.removeObject(forKey: legacyKey(mailbox))
    }
}
