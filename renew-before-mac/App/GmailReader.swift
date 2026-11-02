import Foundation
import PDFKit

enum GmailReadError: Error, LocalizedError {
    case unauthorized, forbidden, throttled, unavailable, invalidResponse, missingMessage, oversized

    var errorDescription: String? {
        switch self {
        case .unauthorized: return L10n.text("Your Google sign-in has expired. Reconnect Gmail and try again.")
        case .forbidden: return L10n.text("Google blocked Gmail access. Check that the Gmail API is enabled and that this account has granted read access.")
        case .throttled: return L10n.text("Gmail is receiving too many requests. Please try again later.")
        case .unavailable: return L10n.text("Could not reach Gmail. Check your connection and try again.")
        case .invalidResponse: return L10n.text("Gmail returned an unreadable response. Please try again.")
        case .missingMessage: return L10n.text("This email is no longer available.")
        case .oversized: return L10n.text("This email exceeds the scan size limit.")
        }
    }
}

struct GmailReader {
    private let session: URLSession
    private static let limit = 30
    private static let maxResponse = 1_048_576
    fileprivate static let maxPDFBytes = 512 * 1024
    // Query incoming mail rather than the user's outgoing correspondence. Archived mail is included.
    private static let incoming = "newer_than:90d -in:sent -in:drafts "
    private static let billingQuery = incoming + #"{subject:receipt subject:invoice subject:subscription subject:membership subject:renewal subject:renewed subject:billing subject:cancellation subject:canceled subject:cancelled subject:收據 subject:訂閱 subject:付款成功 subject:"payment confirmation" subject:"payment successful" subject:"invoice paid" subject:"payment received" subject:"payment failed" subject:"payment declined" subject:"trial ends"}"#

    // Limit the second search to payment evidence with a recurring-billing or plan cue.
    // Keep processor receipts eligible even if the merchant is identified only in the subject.
    private static let paidReceiptQuery = incoming
        + #"{subject:receipt subject:"payment received" subject:"payment successful" subject:"payment confirmation" subject:"you paid" subject:"invoice paid" subject:"paid invoice" subject:收據 subject:付款成功 subject:付款確認 subject:扣款成功} "#
        + #"{subscription membership renewal recurring "monthly plan" "annual plan" "per month" "per year" "billed monthly" "billed annually" 訂閱 續訂 月費 年費 from:anthropic.com from:github.com from:openai.com subject:"receipt from Anthropic" subject:"receipt from OpenAI" subject:"receipt from GitHub" "#
        + MailReceiptTerms.planNames.map { "\"" + $0 + "\"" }.joined(separator: " ") + "}"

    private static let privateSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 35
        return URLSession(configuration: config, delegate: GmailNoRedirects.shared, delegateQueue: nil)
    }()

    init(session: URLSession? = nil) {
        self.session = session ?? Self.privateSession
    }

    func emailAddress(accessToken: String) async throws -> String {
        struct Profile: Decodable { let emailAddress: String }
        let profile: Profile = try await get("profile", token: accessToken, query: [.init(name: "fields", value: "emailAddress")])
        guard !profile.emailAddress.isEmpty else { throw GmailReadError.invalidResponse }
        return profile.emailAddress
    }

    func scan(accessToken: String) async throws -> MailScanBatch {
        let billing = try await matchingIDs(Self.billingQuery, token: accessToken)
        let receipts = try await matchingIDs(Self.paidReceiptQuery, token: accessToken, excluding: Set(billing.ids))
        let ids = billing.ids + receipts.ids
        var messages: [MailScanMessage] = []
        var skipped = 0, pdfBudget = 8, pdfsUsed = 0
        for id in ids {
            try Task.checkCancellation()
            guard Self.isSafeID(id, maxLength: 128) else { skipped += 1; continue }
            do {
                let query = [URLQueryItem(name: "format", value: "full"),
                             .init(name: "fields", value: "id,internalDate,payload")]
                let raw: GmailEnvelope = try await get("messages/" + id, token: accessToken, query: query)
                guard raw.id == id, let original = raw.message() else { skipped += 1; continue }
                let message = try await withReceiptPDF(original, payload: raw.payload, token: accessToken,
                                                       budget: &pdfBudget, included: &pdfsUsed)
                if message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { skipped += 1 }
                else { messages.append(message) }
            } catch GmailReadError.missingMessage { skipped += 1 }
              catch GmailReadError.oversized { skipped += 1 }
              catch GmailReadError.invalidResponse { skipped += 1 }
        }
        return MailScanBatch(messages: messages, inspected: ids.count, limited: billing.limited || receipts.limited,
                             skipped: skipped, additionalReceiptEmails: receipts.ids.count, receiptPDFsUsed: pdfsUsed)
    }

    private func withReceiptPDF(_ original: MailScanMessage, payload: GmailEnvelope.Part, token: String,
                                budget: inout Int, included: inout Int) async throws -> MailScanMessage {
        let subject = original.subject
        let billing = #"(?i)\b(?:receipt|invoice|payment (?:received|confirmed|successful|confirmation))\b|收據|發票|付款(?:成功|確認)|扣款成功"#
        let unrelated = #"(?i)^\s*(?:re|fw|fwd):|\b(?:refund|failed|declined|upcoming|quote|estimate|newsletter|offer|overdue)\b|退款|失敗|報價|限時優惠"#
        guard budget > 0, subject.range(of: billing, options: .regularExpression) != nil,
              subject.range(of: unrelated, options: .regularExpression) == nil else { return original }
        var parts: [GmailEnvelope.Part] = [], nodes = 80
        payload.receiptPDFs(depth: 0, nodes: &nodes, found: &parts)
        let originalEvidence = PaymentDiscovery.scan(from: [original], mailbox: "")
        guard !parts.isEmpty, originalEvidence.payments.isEmpty, originalEvidence.currencyReviews.isEmpty,
              originalEvidence.paymentReviews.isEmpty else { return original }

        // A merchant can enclose both the invoice and its receipt. Prefer the receipt and keep
        // every document separate so a paid label from one cannot qualify a total in another.
        let preferred = parts.filter(\.isReceipt) + parts.filter { !$0.isReceipt }
        var selected: MailScanMessage?
        for part in preferred.prefix(min(2, budget)) {
            try Task.checkCancellation()
            budget -= 1
            do {
                guard let text = try await pdfText(part, messageID: original.id, token: token) else { continue }
                let combined = MailScanMessage(id: original.id, subject: subject, sender: original.sender,
                                              body: text + "\n" + original.body, receivedAt: original.receivedAt,
                                              authenticatedSenderDomain: original.authenticatedSenderDomain)
                let evidence = PaymentDiscovery.scan(from: [combined], mailbox: "")
                if !evidence.payments.isEmpty { selected = combined; break }
                if selected == nil || !evidence.currencyReviews.isEmpty || !evidence.paymentReviews.isEmpty { selected = combined }
            } catch let error as GmailReadError {
                if error == .unauthorized { throw error }
                if error == .throttled || error == .unavailable { budget = 0; break }
                // Unreadable or missing optional PDFs do not discard a usable message body.
            }
        }
        if let selected { included += 1; return selected }
        return original
    }

    private func pdfText(_ part: GmailEnvelope.Part, messageID: String, token: String) async throws -> String? {
        guard let body = part.body, let size = body.size, (1...Self.maxPDFBytes).contains(size) else { return nil }
        let encoded: String?
        if let inline = body.data, !inline.isEmpty {
            encoded = inline
        } else if let attachmentID = body.attachmentId, Self.isSafeID(attachmentID, maxLength: 1024) {
            let attached: GmailEnvelope.Part.Body = try await get("messages/" + messageID + "/attachments/" + attachmentID,
                token: token, query: [.init(name: "fields", value: "attachmentId,size,data")])
            guard attached.size == size, attached.attachmentId == nil || attached.attachmentId == attachmentID else { return nil }
            encoded = attached.data
        } else { return nil }
        guard let encoded, encoded.utf8.count <= ((size + 2) / 3) * 4,
              let bytes = GmailEnvelope.Part.decodeBase64(encoded), bytes.count == size,
              bytes.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: bytes),
              !document.isLocked, document.allowsCopying, (1...5).contains(document.pageCount) else { return nil }
        var text = ""
        for index in 0..<document.pageCount {
            let page = document.page(at: index)?.string ?? ""
            guard page.utf8.count + text.utf8.count + 1 <= 16_384 else { return nil }
            text += page + "\n"
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
    }

    private func matchingIDs(_ search: String, token: String, excluding: Set<String> = []) async throws -> (ids: [String], limited: Bool) {
        struct Page: Decodable {
            struct Reference: Decodable { let id: String }
            let messages: [Reference]?
            let nextPageToken: String?
        }

        var ids: [String] = []
        var seen = excluding
        var pageToken: String?
        var pages = 0
        repeat {
            // Overlap between the two searches is expected. Request enough IDs for that
            // overlap plus one extra distinct match to detect truncation without reading it.
            let pageSize = Self.limit + 1 + excluding.count - ids.count
            var query = [URLQueryItem(name: "q", value: search),
                         .init(name: "includeSpamTrash", value: "false"),
                         .init(name: "maxResults", value: String(pageSize)),
                         .init(name: "fields", value: "messages/id,nextPageToken")]
            if let pageToken { query.append(.init(name: "pageToken", value: pageToken)) }
            let page: Page = try await get("messages", token: token, query: query)
            pages += 1
            for entry in (page.messages ?? []).prefix(pageSize) where seen.insert(entry.id).inserted {
                ids.append(entry.id)
                if ids.count > Self.limit { break }
            }
            pageToken = page.nextPageToken
        } while !(pageToken ?? "").isEmpty && ids.count <= Self.limit && pages < 5
        return (Array(ids.prefix(Self.limit)), ids.count > Self.limit || !(pageToken ?? "").isEmpty)
    }

    private static func isSafeID(_ id: String, maxLength: Int) -> Bool {
        id.utf8.count > 0 && id.utf8.count <= maxLength && id.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    private func get<T: Decodable>(_ resource: String, token: String, query: [URLQueryItem]) async throws -> T {
        try Task.checkCancellation()
        guard !token.isEmpty else { throw GmailReadError.unauthorized }
        var url = URLComponents()
        url.scheme = "https"
        url.host = "gmail.googleapis.com"
        url.path = "/gmail/v1/users/me/" + resource
        url.queryItems = query
        guard let endpoint = url.url else { throw GmailReadError.invalidResponse }
        var request = URLRequest(url: endpoint)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            defer { bytes.task.cancel() }
            guard let http = response as? HTTPURLResponse else { throw GmailReadError.invalidResponse }
            switch http.statusCode {
            case 200: break
            case 401: throw GmailReadError.unauthorized
            case 403: throw GmailReadError.forbidden
            case 404: throw GmailReadError.missingMessage
            case 429: throw GmailReadError.throttled
            case 500...599: throw GmailReadError.unavailable
            default: throw GmailReadError.invalidResponse
            }
            guard response.expectedContentLength <= Self.maxResponse else { throw GmailReadError.oversized }
            var data = Data()
            for try await byte in bytes {
                guard data.count < Self.maxResponse else { throw GmailReadError.oversized }
                data.append(byte)
            }
            try Task.checkCancellation()
            guard let value = try? JSONDecoder().decode(T.self, from: data) else { throw GmailReadError.invalidResponse }
            return value
        } catch let error as URLError {
            if error.code == .cancelled || Task.isCancelled { throw CancellationError() }
            throw GmailReadError.unavailable
        }
    }
}

private final class GmailNoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = GmailNoRedirects()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct GmailEnvelope: Decodable {
    let id: String
    let internalDate: String
    let payload: Part

    struct Part: Decodable {
        struct Header: Decodable { let name, value: String }
        struct Body: Decodable { let attachmentId, data: String?; let size: Int? }
        let mimeType: String
        let filename: String?
        let headers: [Header]?
        let body: Body?
        let parts: [Part]?

        func header(_ name: String) -> String? {
            headers?.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value
        }

        var isReceipt: Bool {
            (filename ?? "").range(of: #"(?i)receipt|收據"#, options: .regularExpression) != nil
        }

        func receiptPDFs(depth: Int, nodes: inout Int, found: inout [Part]) {
            guard depth < 8, nodes > 0 else { return }
            nodes -= 1
            let mime = mimeType.lowercased()
            if mime.hasPrefix("multipart/"), (filename ?? "").isEmpty,
               !(header("Content-Disposition") ?? "").lowercased().contains("attachment") {
                for part in parts ?? [] {
                    guard nodes > 0 else { break }
                    part.receiptPDFs(depth: depth + 1, nodes: &nodes, found: &found)
                }
            } else if mime == "application/pdf", let name = filename?.lowercased(), name.hasSuffix(".pdf"),
                      name.range(of: #"receipt|invoice|收據|發票"#, options: .regularExpression) != nil,
                      let size = body?.size, (1...GmailReader.maxPDFBytes).contains(size) {
                found.append(self)
            }
        }

        static func decodeBase64(_ encoded: String) -> Data? {
            var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)
            return Data(base64Encoded: base64)
        }

        func collect(depth: Int, budget: inout Int, plain: inout String?, html: inout String?) {
            guard depth < 8, budget > 0, plain == nil else { return }
            budget -= 1
            let disposition = header("Content-Disposition")?.lowercased() ?? ""
            guard (filename ?? "").isEmpty, body?.attachmentId == nil,
                  !disposition.contains("attachment"), !disposition.contains("filename") else { return }
            let mime = mimeType.lowercased()
            if mime.hasPrefix("multipart/") {
                for part in parts ?? [] {
                    guard budget > 0, plain == nil else { break }
                    part.collect(depth: depth + 1, budget: &budget, plain: &plain, html: &html)
                }
            } else if mime == "text/plain" || (mime == "text/html" && html == nil) {
                guard let encoded = body?.data, encoded.utf8.count <= 524_288 else { return }
                guard let data = Self.decodeBase64(encoded) else { return }
                let declared = header("Content-Type")?.lowercased() ?? ""
                let encoding: String.Encoding = declared.contains("windows-1252") ? .windowsCP1252 :
                    (declared.contains("iso-8859-1") ? .isoLatin1 : .utf8)
                guard let text = String(data: data, encoding: encoding), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                if mime == "text/plain" { plain = text } else { html = text }
            }
        }
    }

    func message() -> MailScanMessage? {
        guard let millis = Int64(internalDate), millis > 0,
              let subject = payload.header("Subject"), let sender = payload.header("From") else { return nil }
        var plain: String?, html: String?
        var budget = 80
        payload.collect(depth: 0, budget: &budget, plain: &plain, html: &html)
        let body = plain ?? html.map(Self.visibleText) ?? "" // A receipt may consist entirely of a PDF.
        let authentication = (payload.headers ?? []).filter { $0.name.caseInsensitiveCompare("Authentication-Results") == .orderedSame }.map(\.value)
        return MailScanMessage(id: id, subject: String(subject.prefix(512)), sender: String(sender.prefix(512)),
                               body: String(body.prefix(24_000)), receivedAt: Date(timeIntervalSince1970: Double(millis) / 1_000),
                               authenticatedSenderDomain: SenderAuthentication.gmailDomain(results: authentication, sender: sender))
    }

    // Only transform text. Never render HTML, visit links, or load remote images.
    private static func visibleText(_ html: String) -> String {
        var text = html.replacingOccurrences(of: #"(?is)<!--.*?(?:-->|$)|<(script|style|head)\b[^>]*>.*?(?:</\1\s*>|$)"#,
                                            with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)<(?:br\b[^>]*|/(?:p|div|tr|li|h[1-6]))\s*/?>"#, with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^<>]*>"#, with: " ", options: .regularExpression)
        for (entity, value) in [("&nbsp;", " "), ("&quot;", "\""), ("&apos;", "'"), ("&#39;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: value, options: .caseInsensitive)
        }
        return text
    }
}
