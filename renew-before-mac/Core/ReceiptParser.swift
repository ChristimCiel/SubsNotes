import CryptoKit
import Foundation
import PDFKit

struct ReceiptDraft {
    var name: String?
    var amount: Decimal?
    var currency: String?
    var cadence: Cadence?
    var nextBilling: Date?
    var receiptID: String
    var excerpt: String
}

enum ReceiptImportError: LocalizedError {
    case tooLarge, tooMuchText, unsupportedFile, invalidText, empty, invalidMail, unsupportedMail, ambiguousMail
    case invalidPDF, lockedPDF, tooManyPages, imagePDF
    var errorDescription: String? {
        switch self {
        case .tooLarge: return "This receipt exceeds 4 MiB. Paste just the relevant billing lines."
        case .tooMuchText: return "The extracted text exceeds 1 MiB. Paste just the relevant billing lines."
        case .unsupportedFile: return "Choose a .txt, .eml, or text-based .pdf receipt."
        case .invalidText: return "This receipt needs readable UTF-8 plain text. Copy and paste the billing details."
        case .empty: return "This receipt is empty."
        case .invalidMail: return "This email could not be decoded. Paste the visible billing details instead."
        case .unsupportedMail: return "This email needs a supported inline plain-text body. Paste the visible billing details instead."
        case .ambiguousMail: return "This email contains multiple plain-text bodies. Paste the relevant billing details."
        case .invalidPDF: return "This PDF could not be opened. Choose a text-based PDF or paste the billing details."
        case .lockedPDF: return "This PDF is locked or restricts text extraction. Paste the billing details you can access."
        case .tooManyPages: return "Choose a PDF of 20 pages or fewer, or paste the relevant billing details."
        case .imagePDF: return "This PDF has no selectable text. Enter the details manually or paste them from the billing page."
        }
    }
}

enum ReceiptParser {
    static let maxBytes = 4 * 1_048_576
    private static let maxTextBytes = 1_048_576
    private static let maxPDFPages = 20
    private enum Field {
        case name, amount, currency, cadence, nextBilling
    }

    private static let labels: [String: Field] = [
        "service": .name, "service name": .name, "subscription name": .name, "product": .name,
        "amount": .amount, "recurring amount": .amount, "renewal amount": .amount,
        "next charge amount": .amount, "subscription price": .amount, "recurring charge": .amount,
        "recurring total": .amount, "renewal price": .amount, "next renewal amount": .amount,
        "currency": .currency, "currency code": .currency,
        "cadence": .cadence, "billing cycle": .cadence, "billing frequency": .cadence,
        "billing interval": .cadence, "billing period": .cadence, "billed every": .cadence,
        "next billing": .nextBilling, "next billing date": .nextBilling, "next charge date": .nextBilling,
        "next renewal": .nextBilling, "next renewal date": .nextBilling, "renewal date": .nextBilling,
        "next payment date": .nextBilling
    ]

    static func parse(_ data: Data, filename: String) throws -> ReceiptDraft {
        guard data.count <= maxBytes else { throw ReceiptImportError.tooLarge }
        let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
        var text: String
        switch ext {
        case "pdf":
            text = try pdfText(data)
        case "txt", "eml":
            guard var input = String(data: data, encoding: .utf8) else { throw ReceiptImportError.invalidText }
            if input.first == "\u{FEFF}" { input.removeFirst() }
            text = ext == "eml" ? try MailText.extract(normalizedLines(input)) : input
        default:
            throw ReceiptImportError.unsupportedFile
        }
        if text.first == "\u{FEFF}" { text.removeFirst() }
        guard text.utf8.count <= maxTextBytes else { throw ReceiptImportError.tooMuchText }
        text = normalizedLines(text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ReceiptImportError.empty }
        guard text.unicodeScalars.allSatisfy({ $0.value >= 32 || $0 == "\n" || $0 == "\t" }) else {
            throw ReceiptImportError.invalidText
        }

        var fields: [Field: [String]] = [:]
        var evidence: [String] = []
        for line in text.split(separator: "\n") {
            if let colon = line.firstIndex(of: ":") {
                let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                guard let field = labels[key] else { continue }
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                fields[field, default: []].append(value)
            } else {
                let phrase = line.trimmingCharacters(in: .whitespaces).lowercased()
                guard phrase.hasPrefix("billed every ") || ["billed monthly", "billed annually", "billed yearly"].contains(phrase) else { continue }
                fields[.cadence, default: []].append(String(phrase.dropFirst(7)))
            }
            if evidence.count < 8 {
                evidence.append(String(line.prefix(200)))
            }
        }

        let prices = fields[.amount, default: []].map(parsePrice)
        let codes = fields[.currency, default: []].map { parseCurrency($0) }
            + prices.compactMap { $0?.code }.map(Optional.some)
        let currency = prices.contains(where: { $0 == nil }) ? nil : agreed(codes)
        let rateUnits = prices.compactMap { $0?.unit }
        let cadence = agreed(fields[.cadence, default: []].map(parseCadence) + rateUnits.map(Optional.some))
        let priceIsConsistent = (codes.isEmpty || currency != nil) && (rateUnits.isEmpty || cadence != nil)

        let digest = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        return ReceiptDraft(
            name: agreed(fields[.name, default: []].map { $0.isEmpty ? nil : $0 }),
            amount: priceIsConsistent ? agreed(prices.map { $0?.amount }) : nil,
            currency: currency,
            cadence: cadence,
            nextBilling: agreed(fields[.nextBilling, default: []].map(parseBillingDay)),
            receiptID: digest,
            excerpt: String((evidence.isEmpty ? text : evidence.joined(separator: "\n")).prefix(600))
        )
    }

    // An unparseable occurrence also makes the field uncertain.
    private static func agreed<T: Equatable>(_ values: [T?]) -> T? {
        guard let first = values.first, let first, values.allSatisfy({ $0 == first }) else { return nil }
        return first
    }

    private static func parseCurrency(_ value: String) -> String? {
        let code = value.uppercased()
        return Ledger.isCurrency(code) ? code : nil
    }

    private static let pricePattern = try! NSRegularExpression(
        pattern: #"^(?:([A-Za-z]{3})\s*)?([0-9]{1,20}(?:\.[0-9]{1,8})?)(?:\s*([A-Za-z]{3}))?(?:\s*(?:/\s*|per\s+)(month|year))?$"#,
        options: .caseInsensitive
    )

    private static func parsePrice(_ value: String) -> (amount: Decimal, code: String?, unit: Cadence?)? {
        let range = NSRange(value.startIndex..., in: value)
        guard let match = pricePattern.firstMatch(in: value, range: range),
              let numberRange = Range(match.range(at: 2), in: value),
              let amount = Decimal(string: String(value[numberRange]), locale: Locale(identifier: "en_US_POSIX"))
        else { return nil }
        let codes = [1, 3].compactMap { Range(match.range(at: $0), in: value) }.map { String(value[$0]) }
        guard codes.count <= 1 else { return nil }
        let unit = Range(match.range(at: 4), in: value).flatMap { parseCadence(String(value[$0])) }
        if let first = codes.first {
            guard let currency = parseCurrency(first) else { return nil }
            return (amount, currency, unit)
        }
        return (amount, nil, unit)
    }

    private static func parseCadence(_ value: String) -> Cadence? {
        switch value.lowercased() {
        case "month", "1 month", "monthly", "per month", "every month", "every 1 month": return .monthly
        case "year", "1 year", "annual", "annually", "yearly", "per year", "every year", "every 1 year": return .annual
        default: return nil
        }
    }

    private static func normalizedLines(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    private static let englishDates = ["MMMM d, yyyy", "MMM d, yyyy", "d MMMM yyyy", "d MMM yyyy"].map { format in
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.isLenient = false
        formatter.dateFormat = format
        return formatter
    }

    private static func parseBillingDay(_ value: String) -> Date? {
        if let day = Day.parse(value) { return day }
        guard (10...24).contains(value.utf8.count), value.utf8.contains(where: { (65...90).contains($0) || (97...122).contains($0) }) else { return nil }
        for formatter in englishDates {
            if let day = formatter.date(from: value), formatter.string(from: day).caseInsensitiveCompare(value) == .orderedSame {
                return day
            }
        }
        return nil
    }

    private static func pdfText(_ data: Data) throws -> String {
        guard data.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: data) else {
            throw ReceiptImportError.invalidPDF
        }
        guard !document.isLocked, document.allowsCopying else { throw ReceiptImportError.lockedPDF }
        guard document.pageCount > 0 else { throw ReceiptImportError.invalidPDF }
        guard document.pageCount <= maxPDFPages else { throw ReceiptImportError.tooManyPages }
        var pages: [String] = []
        var count = 0
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { throw ReceiptImportError.invalidPDF }
            guard let text = page.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            count += text.utf8.count + (pages.isEmpty ? 0 : 1)
            guard count <= maxTextBytes else { throw ReceiptImportError.tooMuchText }
            // PDFKit versions differ in whether separated visual rows contain newlines.
            // Preserve explicit field boundaries; never promote Amount paid to a recurring rate.
            let fieldLabels = (Array(labels.keys) + ["amount paid", "invoice date"])
                .sorted { $0.count > $1.count }.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|")
            let boundary = "(?i)[ \\t]+(?=(?:" + fieldLabels + ")\\s*:|billed (?:every\\b|monthly\\b|annually\\b|yearly\\b))"
            pages.append(text.replacingOccurrences(of: boundary, with: "\n", options: .regularExpression))
        }
        guard !pages.isEmpty else { throw ReceiptImportError.imagePDF }
        return pages.joined(separator: "\n")
    }
}
