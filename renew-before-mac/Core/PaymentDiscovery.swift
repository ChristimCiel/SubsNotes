import Foundation

enum PaymentDiscovery {
    private static let strongLabel = #"(?i)^(?:amount paid|total paid|payment received|total charged|amount charged|you paid|實付金額|實際付款金額|已付金額|付款成功金額)\s*[:：]?\s*"#
    private static let totalLabel = #"(?i)^(?:grand total|total|付款金額|總計|合計)\s*[:：]?\s*"#
    private static let paidReceipt = #"(?i)\b(?:receipt|successfully paid|payment (?:was )?(?:received|successful|confirmed)|we(?:['’]ve| have)? received your payment|invoice (?:is |was )?paid|paid in full)\b|收據|付款成功"#
    private static let disqualifier = #"(?i)\b(?:refund(?:ed)?|credit note|credit memo|past due|payment failed|payment declined|estimate|quotation|pro forma|upcoming invoice|amount overdue|unpaid invoice)\b|退款|付款失敗"#
    private static let incomingFunds = "(?im)" + [
        #"\byou(?:['’]ve| have)?\s+(?:just\s+)?received\s+(?:(?:a|your|another)\s+)?(?:new\s+)?(?:payment|payout|deposit)\b"#,
        #"\b(?:sent|paid)\s+you\s+(?:a\s+payment\b|money\b|\p{Sc}\s*\d|[A-Z]{3}\s+\d)"#,
        #"\b(?:payer|customer|client)\s+(?:has\s+)?(?:paid|sent)\s+you\b"#,
        #"^(?:(?:your|daily|weekly|monthly|stripe|paypal)\s+)*(?:payout|deposit)\s+(?:summary|report|confirmation|details|arrived|on the way|is on (?:its|the) way)\b"#,
        #"\b(?:credited|deposited)\s+(?:to|into)\s+your\s+(?:bank\s+account|balance)\b"#,
        #"您(?:已)?收到(?:一筆)?(?:來自.+的)?款項|收款通知|撥款明細"#
    ].joined(separator: "|")

    static func payments(from messages: [MailScanMessage], mailbox: String) -> [RecordedPayment] {
        scan(from: messages, mailbox: mailbox).payments
    }

    static func currencyReviews(from messages: [MailScanMessage], mailbox: String) -> [PaymentCurrencyReview] {
        scan(from: messages, mailbox: mailbox).currencyReviews
    }

    static func scan(from messages: [MailScanMessage], mailbox: String) ->
        (payments: [RecordedPayment], currencyReviews: [PaymentCurrencyReview], paymentReviews: [PaymentReview]) {
        let account = mailbox.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var groups = [String: [(receipt: PaymentCurrencyReview, currency: String?, trusted: Bool)]]()
        for message in messages.sorted(by: { $0.receivedAt < $1.receivedAt }) {
            guard let result = settlement(from: message, account: account) else { continue }
            groups[result.receipt.id, default: []].append(result)
        }
        var payments = [RecordedPayment]()
        var currencyReviews = [PaymentCurrencyReview]()
        var paymentReviews = [PaymentReview]()
        for id in groups.keys.sorted() {
            guard let group = groups[id], let first = group.first else { continue }
            let amounts = Set(group.map { $0.receipt.amount })
            let currencies = Set(group.compactMap { $0.currency })
            let reason: PaymentReviewReason?
            if amounts.count > 1 || currencies.count > 1 {
                reason = .conflictingReceipt
            } else if !group.contains(where: { $0.trusted }) {
                reason = .unverifiedMerchant
            } else {
                reason = nil
            }
            if let reason {
                var seen = Set<String>()
                let options = group.map { PaymentReviewOption($0.receipt, currency: $0.currency) }
                    .filter { seen.insert($0.id).inserted }.sorted { $0.id < $1.id }
                paymentReviews.append(PaymentReview(id: id, reason: reason, options: options))
            } else if let currency = currencies.first {
                payments.append(first.receipt.payment(currency: currency))
            } else {
                currencyReviews.append(first.receipt)
            }
        }
        return (payments, currencyReviews, paymentReviews)
    }

    private struct Money: Hashable {
        let amount: Decimal
        let currency: String?
    }

    private static func settlement(from message: MailScanMessage, account: String) -> (receipt: PaymentCurrencyReview, currency: String?, trusted: Bool)? {
        guard message.subject.range(of: disqualifier, options: .regularExpression) == nil else { return nil }
        let candidate = MailDiscovery.candidate(from: message, account: account)
        if let candidate, candidate.kind != .receipt && candidate.kind != .renewal { return nil }
        let issuer = recognizedIssuer(sender: message.sender, subject: message.subject)
        guard let service = candidate?.name ?? issuer?.service else { return nil }
        if candidate == nil && message.subject.range(of: #"(?i)\b(?:newsletter|special offer|sample receipt)\b"#, options: .regularExpression) != nil { return nil }
        let lines = MailDiscovery.currentMessageLines(message.body).filter { !$0.isEmpty }
        guard ([message.subject] + lines).joined(separator: "\n").range(of: incomingFunds, options: .regularExpression) == nil else { return nil }
        let documentCurrency = Set(lines.compactMap { captures(#"(?i)^(?:payment |billing )?currency(?: code)?\s*[:：]\s*([A-Z]{3})$"#, $0)?.first?.uppercased() })
        let currency = documentCurrency.count == 1 ? documentCurrency.first : nil
        let reversedOrUnpaid = #"(?im)^(?:(?:(?:payment|invoice|transaction) status|status)\s*[:：]\s*(?:unpaid|pending|failed|declined|void(?:ed)?|refund(?:ed)?|cancell?ed|due|overdue)\b|balance (?:remains )?unpaid\b|credit (?:note|memo)(?: number)?\s*[:#]|付款狀態\s*[:：]\s*(?:未付|退款|失敗))"#
        guard lines.joined(separator: "\n").range(of: reversedOrUnpaid, options: .regularExpression) == nil else { return nil }
        for (index, line) in lines.enumerated() {
            if let label = line.range(of: #"(?i)^(?:amount refunded|refund amount|退款金額)\s*[:：]\s*"#, options: .regularExpression) {
                let field = fieldValue(after: label, at: index, in: lines)
                guard parseMoney(field, documentCurrency: currency)?.amount == 0 else { return nil }
            }
        }
        let paidDocument = message.subject.range(of: paidReceipt, options: .regularExpression) != nil ||
            lines.contains { $0.range(of: #"(?i)^(?:(?:payment status|status)\s*:\s*paid|paid in full|payment successful|payment received|we(?:['’]ve| have)? received your payment|付款成功)\s*[.!]?$"#, options: .regularExpression) != nil } ||
            lines.enumerated().contains { index, line in
                guard let label = line.range(of: #"(?i)^(?:date paid|paid on)\s*[:：]?\s*"#, options: .regularExpression) else { return false }
                return parseDay(fieldValue(after: label, at: index, in: lines)) != nil
            }
        // Strong settlement fields take precedence over a subtotal, rate or invoice total.
        var paid = Set<Money>(), totals = Set<Money>()
        var sawPaidLabel = false
        var datedSettlement: String?
        for (index, line) in lines.enumerated() {
            if let lineItems = captures(#"(?i)^(.{1,28}?)\s+paid on\s+(.{5,32})$"#, line),
               let money = parseMoney(lineItems[0], documentCurrency: currency), parseDay(lineItems[1]) != nil {
                paid.insert(money)
                sawPaidLabel = true
                datedSettlement = lineItems[1]
                continue
            }
            if index > 0, let label = line.range(of: #"(?i)^paid on\s*[:：]?\s*"#, options: .regularExpression),
               let money = parseMoney(lines[index - 1], documentCurrency: currency) {
                let field = fieldValue(after: label, at: index, in: lines)
                if parseDay(field) != nil {
                    paid.insert(money)
                    sawPaidLabel = true
                    datedSettlement = field
                }
            }
            let isPaid = line.range(of: strongLabel, options: .regularExpression)
            guard let label = isPaid ?? (paidDocument ? line.range(of: totalLabel, options: .regularExpression) : nil) else { continue }
            let field = fieldValue(after: label, at: index, in: lines)
            // Some receipts use "Payment received" as a heading, not a value.
            if isPaid != nil && field.rangeOfCharacter(from: .decimalDigits) != nil { sawPaidLabel = true }
            // If a paid value is ambiguous, do not substitute the nominal total.
            guard let money = parseMoney(field, documentCurrency: currency) else { continue }
            if isPaid != nil { paid.insert(money) } else { totals.insert(money) }
        }
        let chosen = sawPaidLabel ? paid : totals
        guard chosen.count == 1, let money = chosen.first, money.amount > 0,
              money.currency != nil || documentCurrency.isEmpty else { return nil }
        // A cancellation notice can include an old invoice or a quoted plan total.
        if !sawPaidLabel && message.subject.range(of: #"(?i)\b(?:cancell?ed|cancell?ation)\b|取消訂閱|訂閱已取消"#, options: .regularExpression) != nil { return nil }
        if candidate == nil && !paidDocument && datedSettlement == nil &&
            message.subject.range(of: #"(?i)\b(?:invoice|billing statement|payment confirmation)\b|發票|付款確認"#, options: .regularExpression) == nil {
            return nil
        }

        let receiptDay = Day.fromLocal(message.receivedAt)
        let paidDay = labeledDate(lines) ?? datedSettlement.flatMap(parseDay)
        guard paidDay.map({ $0 <= receiptDay.addingTimeInterval(86_400) }) ?? true else { return nil }
        // A merchant reference deduplicates copies of the same receipt across different Gmail messages.
        // Without a reference, preserve distinct messages; the owner can exclude a duplicate.
        let reference = documentReference(lines)
        let identity: String
        if let reference {
            // Match MailDiscovery's merchant key when the same receipt also identifies a subscription.
            let merchant: String
            if let issuer, issuer.domain == "stripe.com" {
                merchant = PaymentStore.digest([account, issuer.domain, issuer.service.lowercased()].joined(separator: "\u{1F}"))
            } else if let candidate { merchant = candidate.id }
            else if let issuer { merchant = PaymentStore.digest([account, issuer.domain, service.lowercased()].joined(separator: "\u{1F}")) }
            else { return nil }
            identity = "document|" + merchant + "|" + reference
        } else if let candidate {
            identity = "message|" + candidate.draft.receiptID
        } else {
            // Gmail gives every message a stable ID, independent of the price and currency parsed.
            guard !message.id.isEmpty else { return nil }
            let subject = String(message.subject.prefix(250)).trimmingCharacters(in: .whitespacesAndNewlines)
            let sender = String(message.sender.prefix(250)).lowercased()
            identity = "message|" + PaymentStore.digest(["mail", account, sender, subject, message.id].joined(separator: "\u{1F}"))
        }
        return (PaymentCurrencyReview(id: PaymentStore.digest(identity), service: service, amount: money.amount,
                                      day: paidDay ?? receiptDay, dateSource: paidDay == nil ? .emailDate : .paymentDate),
                money.currency, trustedAttribution(message, service: service, issuer: issuer))
    }

    private static func trustedAttribution(_ message: MailScanMessage, service: String,
                                           issuer: (domain: String, service: String)?) -> Bool {
        guard let issuer, let authenticated = message.authenticatedSenderDomain?.lowercased(),
              authenticated == issuer.domain || authenticated.hasSuffix("." + issuer.domain),
              message.subject.range(of: #"(?i)^\s*(?:re|fwd?):"#, options: .regularExpression) == nil else { return false }
        let name = service.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        var aliases = [issuer.service.lowercased()]
        if issuer.service == "Anthropic" { aliases.append("claude") }
        if issuer.service == "OpenAI" { aliases.append("chatgpt") }
        return aliases.contains { name == $0 || name.hasPrefix($0 + " ") }
    }

    // Recognize receipts from a few direct issuers even when no recurring plan is described.
    // A Stripe receipt must also name an exact supported merchant in its subject.
    private static func recognizedIssuer(sender: String, subject: String) -> (domain: String, service: String)? {
        let issuers = ["anthropic.com": "Anthropic", "openai.com": "OpenAI", "github.com": "GitHub",
                       "notion.so": "Notion", "figma.com": "Figma", "vercel.com": "Vercel", "supabase.com": "Supabase"]
        let address = sender.trimmingCharacters(in: .whitespacesAndNewlines)
        let domain = captures(#"^[^<>]*<[^<>\s@]+@([A-Za-z0-9.-]+)>$"#, address)?.first ??
            captures(#"^[^<>\s@]+@([A-Za-z0-9.-]+)$"#, address)?.first
        guard let domain else { return nil }
        var parts = domain.lowercased().components(separatedBy: ".")
        while parts.count > 2 && ["billing", "email", "mail", "receipts", "notifications", "em"].contains(parts[0]) {
            parts.removeFirst()
        }
        let issuer = parts.joined(separator: ".")
        if let service = issuers[issuer] { return (issuer, service) }
        let stripeSubject = #"(?i)^(?:your\s+)?(?:receipt|invoice)\s+from\s+([a-z0-9]+)(?:(?:,\s*|\s+)(?:PBC|Inc\.?|LLC|Ltd\.?|Corporation))?(?:\s+(?:#[\w-]+|\[#[\w-]+\]|\(#[\w-]+\)))?$"#
        guard issuer == "stripe.com",
              let merchant = captures(stripeSubject, subject.trimmingCharacters(in: .whitespacesAndNewlines))?.first,
              let service = issuers.values.first(where: { $0.caseInsensitiveCompare(merchant) == .orderedSame })
        else { return nil }
        return (issuer, service)
    }

    private static func fieldValue(after label: Range<String.Index>, at index: Int, in lines: [String]) -> String {
        let value = String(lines[index][label.upperBound...]).trimmingCharacters(in: .whitespaces)
        return value.isEmpty && index + 1 < lines.count ? lines[index + 1] : value
    }

    private static func parseMoney(_ text: String, documentCurrency: String?) -> Money? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for (symbol, code) in [("US$", "USD "), ("NT$", "TWD "), ("CA$", "CAD "), ("€", "EUR ")] {
            value = value.replacingOccurrences(of: symbol, with: code)
        }
        let number = #"(\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?|\d+(?:\.\d{1,6})?)"#
        let currency = #"([A-Za-z]{3})"#
        var code: String?, digits: String
        if let match = captures("^" + currency + #"\s*\$?\s*"# + number + "$", value) {
            code = match[0]; digits = match[1]
        } else if let match = captures(#"^\$?\s*"# + number + #"\s*"# + currency + "$", value) {
            digits = match[0]; code = match[1]
        } else if let documentCurrency, let match = captures(#"^\$?\s*"# + number + "$", value) {
            digits = match[0]; code = documentCurrency
        } else if let match = captures(#"^\$\s*"# + number + "$", value) {
            digits = match[0]; code = nil
        } else { return nil }
        code = code?.uppercased()
        if let code, !Ledger.isCurrency(code) { return nil }
        guard let amount = Decimal(string: digits.replacingOccurrences(of: ",", with: ""), locale: Locale(identifier: "en_US_POSIX")),
              !amount.isNaN else { return nil }
        return Money(amount: amount, currency: code)
    }

    private static func documentReference(_ lines: [String]) -> String? {
        for kind in ["transaction", "receipt", "invoice"] {
            let pattern = #"(?i)^"# + kind + #"\s*(?:number|no\.?|id|#)\s*[:#]?\s*([a-z0-9][a-z0-9-]{2,64})$"#
            for line in lines {
                if let result = captures(pattern, line)?.first { return kind + "|" + result.lowercased() }
            }
        }
        return nil
    }

    private static func labeledDate(_ lines: [String]) -> Date? {
        for (index, line) in lines.enumerated() {
            guard let label = line.range(of: #"(?i)^(?:date paid|paid on|payment date|transaction date|付款日期)\s*[:：]?\s*"#, options: .regularExpression) else { continue }
            var value = String(line[label.upperBound...]).trimmingCharacters(in: .whitespaces)
            if value.isEmpty, index + 1 < lines.count { value = lines[index + 1] }
            if let day = parseDay(value) { return day }
        }
        return nil
    }

    private static func parseDay(_ value: String) -> Date? {
        if let day = Day.parse(value) { return day }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.isLenient = false
        for format in ["MMMM d, yyyy", "MMM d, yyyy", "d MMMM yyyy", "d MMM yyyy"] {
            formatter.dateFormat = format
            if let day = formatter.date(from: value) { return day }
        }
        return nil
    }

    private static func captures(_ pattern: String, _ text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).compactMap { index in
            Range(match.range(at: index), in: text).map { String(text[$0]) }
        }
    }
}
