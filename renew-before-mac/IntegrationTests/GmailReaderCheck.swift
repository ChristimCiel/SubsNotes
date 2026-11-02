import AppKit
import CoreText
import Foundation

// Run with the production reader and MailScanTypes. URLProtocol intercepts all requests.
private final class GmailStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var reply: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            precondition(request.url?.host == "gmail.googleapis.com")
            precondition(request.httpMethod == "GET")
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token")
            let (status, data) = try Self.reply!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json", "Content-Length": String(data.count)])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@main private enum GmailReaderCheck {
    static func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }

    static func part(_ mime: String, _ text: String) -> [String: Any] {
        let data = Data(text.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return ["mimeType": mime, "body": ["data": data]]
    }
    static func envelope(_ id: String, _ part: [String: Any], subject: String = "Your fictional subscription invoice") -> Data {
        var root = part
        root["headers"] = [["name": "subject", "value": subject],
                           ["name": "FROM", "value": "Anthropic <receipts@anthropic.com>"],
                           ["name": "Authentication-Results", "value": "mx.google.com; dmarc=pass header.from=anthropic.com"]]
        return json(["id": id, "internalDate": "1793505600000", "payload": root])
    }
    private static func pdfDocument() -> Data {
        let bytes = NSMutableData(), page = CGRect(x: 0, y: 0, width: 400, height: 600)
        var box = page
        let output = CGContext(consumer: CGDataConsumer(data: bytes)!, mediaBox: &box, nil)!
        output.beginPDFPage(nil)
        for (index, line) in ["Subscription receipt", "Service: Claude Pro", "Amount paid: EUR 12.75"].enumerated() {
            let text = NSAttributedString(string: line, attributes: [.font: NSFont.systemFont(ofSize: 14)])
            output.textPosition = CGPoint(x: 24, y: 500 - index * 24)
            CTLineDraw(CTLineCreateWithAttributedString(text), output)
        }
        output.endPDFPage()
        output.closePDF()
        return bytes as Data
    }

    private static func checkReceiptPDFs(_ reader: GmailReader, token: String) async throws {
        let pdf = pdfDocument()
        let encoded = pdf.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let inline: [String: Any] = ["mimeType": "application/pdf", "filename": "Receipt-10.pdf",
                                     "body": ["size": pdf.count, "data": encoded]]
        func attachment(_ id: String, _ name: String = "Invoice-101.pdf", size: Int? = nil) -> [String: Any] {
            ["mimeType": "application/pdf", "filename": name, "body": ["size": size ?? pdf.count, "attachmentId": id]]
        }
        func mixed(_ text: String, _ files: [[String: Any]]) -> [String: Any] {
            ["mimeType": "multipart/mixed", "parts": [part("text/plain", text)] + files]
        }
        let ids = ["inline", "external", "complete", "unrelated", "badID", "unavailable", "badSize", "ignored", "count"]
        GmailStub.reply = { request in
            let url = request.url!, key = url.lastPathComponent
            if key == "messages" { return (200, json(["messages": ids.map { ["id": $0] }])) }
            if url.path.contains("/attachments/") {
                switch key {
                case "report-_12":
                    precondition(url.path.hasSuffix("/messages/external/attachments/report-_12"))
                    return (200, json(["data": encoded, "size": pdf.count, "attachmentId": key]))
                case "missing", "first", "second": return (404, json([:]))
                case "bad-size": return (200, json(["data": encoded, "size": pdf.count + 1]))
                default: preconditionFailure("Unnecessary or unsafe attachment request: " + key)
                }
            }
            let body = "Your subscription invoice is attached."
            switch key {
            case "inline": return (200, envelope(key, ["mimeType":"multipart/mixed", "parts":[inline]]))
            case "external": return (200, envelope(key, mixed(body, [attachment("report-_12")])))
            case "complete": return (200, envelope(key, mixed("Service: Other\nSubscription receipt\nAmount paid: EUR 3", [attachment("trap")])))
            case "unrelated": return (200, envelope(key, mixed(body, [attachment("trap")]), subject: "News from our team"))
            case "badID": return (200, envelope(key, mixed(body, [attachment("../unsafe")])))
            case "unavailable": return (200, envelope(key, mixed(body, [attachment("missing")])))
            case "badSize": return (200, envelope(key, mixed(body, [attachment("bad-size")])))
            case "ignored": return (200, envelope(key, mixed(body, [attachment("trap", "Tax-Identity.pdf"), attachment("trap", size: 600_000)])))
            case "count": return (200, envelope(key, mixed(body, [attachment("first"), attachment("second"), attachment("trap")])))
            default: preconditionFailure("Unexpected fixture " + key)
            }
        }
        let found = try await reader.scan(accessToken: token)
        precondition(found.inspected == ids.count && found.skipped == 0 && found.receiptPDFsUsed == 2)
        precondition(Set(found.messages.filter { $0.body.contains("EUR 12.75") }.map(\.id)) == Set(["inline","external"]))
        let paid = PaymentDiscovery.payments(from: found.messages, mailbox: "fixture@example.invalid")
        precondition(paid.count == 2 && paid.allSatisfy { $0.currency == "EUR" && $0.amount == 12.75 })
        precondition(PaymentDiscovery.scan(from: found.messages, mailbox: "fixture@example.invalid").paymentReviews.count == 1)

        GmailStub.reply = { request in
            let key = request.url!.lastPathComponent
            if key == "messages" { return (200, json(["messages": (1...10).map { ["id":String($0)] }])) }
            return (200, envelope(key, ["mimeType":"multipart/mixed", "parts":[inline]]))
        }
        let capped = try await reader.scan(accessToken: token)
        precondition(capped.inspected == 10 && capped.receiptPDFsUsed == 8 && capped.skipped == 2)
    }

    static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GmailStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let reader = GmailReader(session: session)
        let token = "fixture-token"
        GmailStub.reply = { req in
            let url = req.url!
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
            let value: (String) -> String? = { name in query.first { $0.name == name }?.value }
            let key = url.lastPathComponent
            if key == "profile" {
                precondition(value("fields") == "emailAddress")
                return (200, json(["emailAddress": "owner@example.invalid"]))
            }
            if key == "messages" {
                precondition(value("q")!.contains("newer_than:90d") && value("includeSpamTrash") == "false")
                if value("pageToken") == nil { return (200, json(["messages": [["id": "plain"]], "nextPageToken": "two"])) }
                return (200, json(["messages": ["plain","html","attachment","gone","large","../messages","mismatch"].map { ["id": $0] }]))
            }
            precondition(value("format") == "full")
            switch key {
            case "plain":
                var attached = part("text/plain", "Attachment must be ignored")
                attached["headers"] = [["name": "Content-Disposition", "value": "attachment; filename=misleading.txt"]]
                return (200, envelope(key, ["mimeType": "multipart/mixed", "parts": [attached,
                    part("text/html", "<div>html alternative</div>"), part("text/plain", "Service: Fictional Studio\nRecurring amount: USD 9")]]))
            case "html":
                return (200, envelope(key, part("text/html", "<html><head><title>HIDDEN</title></head><script>BAD</script><div>Service: A &amp; B</div><p>Amount: USD 1</p><img src='https://private.example/pixel'></html>")))
            case "attachment":
                var attached = part("text/plain", "Attached receipt"); attached["filename"] = "letter.txt"
                return (200, envelope(key, ["mimeType": "multipart/mixed", "parts": [attached]]))
            case "gone": return (404, json([:]))
            case "large": return (200, Data(repeating: 0, count: 1_048_577))
            case "mismatch": return (200, envelope("another-id", part("text/plain", "wrong!")))
            default: preconditionFailure("Unexpected request")
            }
        }
        let address = try await reader.emailAddress(accessToken: token)
        precondition(address == "owner@example.invalid")
        let scan = try await reader.scan(accessToken: token)
        precondition(scan.inspected == 7 && scan.skipped == 5 && !scan.limited && scan.additionalReceiptEmails == 0)
        precondition(scan.messages.map(\.id) == ["plain", "html"])
        precondition(scan.messages[0].body == "Service: Fictional Studio\nRecurring amount: USD 9")
        let html = scan.messages[1].body
        precondition(html.contains("A & B") && html.contains("Amount: USD 1"))
        for hidden in ["BAD", "HIDDEN", "private.example", "<"] { precondition(!html.contains(hidden)) }

        GmailStub.reply = { req in
            let key = req.url!.lastPathComponent
            if key == "messages" {
                let q = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "q" }!.value!
                let paid = q.contains("YouTube Premium")
                precondition(q.contains("newer_than:90d") && q.contains("subject:付款成功"))
                if paid {
                    precondition(q.contains("subject:receipt") && q.contains("subject:\"payment successful\""))
                    precondition(q.contains("subject:\"receipt from Anthropic\"") && q.contains("subject:\"receipt from OpenAI\"") && q.contains("subject:\"receipt from GitHub\""))
                    precondition(q.contains("from:anthropic.com") && q.contains("from:github.com") && q.contains("from:openai.com"))
                }
                // The receipt search overlaps every general result. Recover 30 additional receipts.
                let ids = paid ? Array(1...30) + Array(101...131) : Array(1...31)
                return (200, json(["messages": ids.map { ["id": String($0)] }]))
            }
            let id = Int(key)!
            precondition((1...30).contains(id) || (101...130).contains(id))
            return (200, envelope(key, part("text/plain", "USD 9 / month")))
        }
        let capped = try await reader.scan(accessToken: token)
        precondition(capped.inspected == 60 && capped.limited && capped.skipped == 0)
        precondition(capped.additionalReceiptEmails == 30 && Set(capped.messages.map(\.id)).count == 60)

        GmailStub.reply = { _ in (200, json(["resultSizeEstimate": 0])) }
        let empty = try await reader.scan(accessToken: token)
        precondition(empty.inspected == 0 && !empty.limited && empty.skipped == 0)

        GmailStub.reply = { req in
            let q = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "q" }!.value!
            return q.contains("YouTube Premium") ? (403, json([:])) : (200, json(["messages": []]))
        }
        do { _ = try await reader.scan(accessToken: token); preconditionFailure("A failed receipt search reported a complete scan") }
        catch GmailReadError.forbidden {}

        for (code, outcome) in [(401, GmailReadError.unauthorized), (403, .forbidden), (429, .throttled), (503, .unavailable)] {
            GmailStub.reply = { _ in (code, json([:])) }
            do { _ = try await reader.scan(accessToken: token); preconditionFailure("Invalid success on HTTP error") }
            catch let error as GmailReadError { precondition(error == outcome) }
        }
        GmailStub.reply = { _ in throw URLError(.notConnectedToInternet) }
        do { _ = try await reader.scan(accessToken: token); preconditionFailure("Offline reported success") }
        catch GmailReadError.unavailable {}
        try await checkReceiptPDFs(reader, token: token)
        print("Gmail reader passed, including inline/remote PDF receipts, successful payment extraction, attachment limits and body preservation: two 90-day searches, 30 + 30 distinct messages despite overlap, pagination, MIME/HTML filtering, skipped mail and failed receipt searches.")
    }
}
