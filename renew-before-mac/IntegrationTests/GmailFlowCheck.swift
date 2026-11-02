import CryptoKit
import Foundation
import Security

/// Calls the real controller, authorization-code exchange, Keychain, Gmail reader (with fake HTTP),
/// and receipt extractor. Only the OAuth callback uses the local network. Requires its QA bundle.
private final class FlowStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var reply: ((URLRequest) -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data = Self.reply!(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class Flow: @unchecked Sendable {
    private let lock = NSLock()
    private var signIns = 0, refreshes = 0
    private var expectedChallenge = "", expectedRedirect = ""

    func counts() -> (Int, Int) { lock.withLock { (signIns, refreshes) } }

    @MainActor func authorize(_ url: URL) -> Bool {
        precondition(url.scheme == "https" && url.host == "accounts.google.com")
        let fields = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        func value(_ name: String) -> String { fields.first { $0.name == name }!.value! }
        precondition(value("scope") == GmailOAuth.scope)
        let redirect = value("redirect_uri"), state = value("state"), challenge = value("code_challenge")
        let callback = URL(string: redirect)!
        precondition(callback.host == "127.0.0.1" && callback.scheme == "http")
        lock.withLock { signIns += 1; expectedChallenge = challenge; expectedRedirect = redirect }
        // Replace the external browser only. Exercise the actual HTTP callback and state validation.
        Task {
            let url = callback.appending(queryItems: [.init(name: "code", value: "fake-code/+&="), .init(name: "state", value: state)])
            do {
                let (_, response) = try await URLSession.shared.data(from: url)
                precondition((response as! HTTPURLResponse).statusCode == 200)
            } catch { preconditionFailure("Local callback failed: \(error.localizedDescription)") }
        }
        return true
    }

    func reply(_ req: URLRequest) -> Data {
        lock.lock(); defer { lock.unlock() }
        let url = req.url!
        func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
        if url.host == "oauth2.googleapis.com" {
            precondition(req.httpMethod == "POST" && url.path == "/token")
            var body = req.httpBody ?? Data()
            if body.isEmpty, let stream = req.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let n = stream.read(&buffer, maxLength: buffer.count)
                    precondition(n >= 0)
                    if n == 0 { break }; body.append(contentsOf: buffer.prefix(n))
                }
            }
            var form = URLComponents()
            form.percentEncodedQuery = String(decoding: body, as: UTF8.self)
            let fields = Dictionary(uniqueKeysWithValues: form.queryItems!.map { ($0.name,$0.value ?? "") })
            precondition(fields["client_id"] == "fixture.apps.googleusercontent.com")
            precondition(fields["client_secret"] == "sample secret/+&")
            if fields["grant_type"] == "authorization_code" {
                precondition(fields["code"] == "fake-code/+&=" && fields["redirect_uri"] == expectedRedirect)
                let verifier = fields["code_verifier"]!
                let actual = GmailOAuth.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
                precondition(actual == expectedChallenge)
                return json(["access_token":"access-\(signIns)", "refresh_token":"refresh-\(signIns)", "scope": GmailOAuth.scope])
            }
            precondition(fields["grant_type"] == "refresh_token" && ["refresh-\(signIns)", "rotated-\(signIns)"].contains(fields["refresh_token"]))
            refreshes += 1
            return json(["access_token":"access-\(signIns)", "refresh_token":"rotated-\(signIns)", "scope":GmailOAuth.scope])
        }
        precondition(url.host == "gmail.googleapis.com" && req.httpMethod == "GET")
        precondition(req.value(forHTTPHeaderField: "Authorization") == "Bearer access-\(signIns)")
        let mailbox = min(signIns, 2) // The third consent reconnects the second fictional account.
        if url.lastPathComponent == "profile" { return json(["emailAddress":"user\(mailbox)@example.invalid"]) }
        if url.lastPathComponent == "messages" {
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "q" }!.value!
            let ids = q.contains("YouTube Premium") ? ["msg-\(mailbox)", "paid-\(mailbox)", "unclear-\(mailbox)"] : ["msg-\(mailbox)"]
            return json(["messages": ids.map { ["id":$0] }])
        }
        let id = url.lastPathComponent
        precondition(["msg-\(mailbox)", "paid-\(mailbox)", "unclear-\(mailbox)"].contains(id))
        let paid = id == "paid-\(mailbox)"
        var mail = "Service: Claude Pro\nSubscription receipt\nRecurring amount: USD 12\nBilling cycle: Monthly"
        if paid { mail += "\nAmount paid: USD 14.50\nReceipt number: FICT-55" }
        if id == "unclear-\(mailbox)" {
            mail = "Service: Claude Pro\nSubscription receipt\nAmount paid: $4.50\nReceipt number: FICT-UNKNOWN"
        }
        return json(["id":id, "internalDate":paid ? "1793505600000" : "1793405600000",
                     "payload":["mimeType":"text/plain","headers":[["name":"Subject","value":"Claude Pro subscription receipt"],
                                                                  ["name":"From","value":"Anthropic <receipts@anthropic.com>"],
                                                                  ["name":"Authentication-Results","value":"mx.google.com; dmarc=pass header.from=anthropic.com"]],
                                "body":["data":Data(mail.utf8).base64EncodedString()]]])
    }
}

@main private enum GmailFlowCheck {
    @MainActor static func expectResults(_ controller: EmailScanController, address: String,
                                         expectedTotals: [String: Decimal] = ["USD": 14.50], expectedReviews: Int = 1) async throws -> MailCandidate {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            switch controller.phase {
            case let .results(account, findings, summary):
                precondition(account.address == address && findings.count == 1)
                precondition(summary.inspected == 3 && summary.additionalReceiptEmails == 2 && summary.skipped == 0 && !summary.limited)
                precondition(summary.recordedCount == expectedTotals.count && summary.recordedTotals == expectedTotals)
                precondition(summary.unresolvedCurrencyCount == expectedReviews && controller.currencyReviews.count == expectedReviews)
                precondition(findings[0].name == "Claude Pro" && findings[0].draft.amount == 12)
                return findings[0]
            case let .failed(message): preconditionFailure("Controller failed: \(message)")
            case .setupRequired: preconditionFailure("Configured fixture requested setup")
            default: try await Task.sleep(for: .milliseconds(15))
            }
        }
        preconditionFailure("Controller did not return results")
    }

    @MainActor static func main() async throws {
        guard Bundle.main.bundleIdentifier?.hasPrefix("org.renewbefore.qa.oauth.") == true else {
            preconditionFailure("This harness must run in its own uniquely identified QA bundle.")
        }
        SecKeychainSetUserInteractionAllowed(false)
        let arguments = CommandLine.arguments
        let seed = arguments.contains("--seed-dashboard")
        let reopen = arguments.contains("--reopen-dashboard")
        let suite = seed || reopen ? Bundle.main.bundleIdentifier! : "org.renewbefore.qa.oauth." + UUID().uuidString
        let defaults = seed || reopen ? UserDefaults.standard : UserDefaults(suiteName: suite)!
        defer { if !seed { defaults.removePersistentDomain(forName: suite) } }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FlowStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let fixture = Flow()
        FlowStub.reply = { fixture.reply($0) }
        let client = GoogleDesktopClient(client_id: "fixture.apps.googleusercontent.com", client_secret: "sample secret/+&")
        let oauth = GmailOAuth(session: session, openBrowser: { fixture.authorize($0) })
        let reader = GmailReader(session: session)
        let vault = GmailVault()
        defer { if !seed { try? vault.remove("connection") } }
        let first = EmailScanController(defaults: defaults, oauth: oauth, reader: reader, vault: vault, bundledClient: client)
        if reopen {
            precondition(first.connectedAddress == "user1@example.invalid" && first.storageWarning == nil)
            precondition(first.pending(for: []).count == 1 && first.payments.count == 1)
            precondition(first.payments[0].amount == 14.50 && first.lastScanSummary?.recordedCount == 1)
            precondition(first.currencyReviews.count == 1 && first.lastScanSummary?.unresolvedCurrencyCount == 1)
            precondition(fixture.counts() == (0,0))
            print("A fresh QA process restored its saved Gmail account, pending service, payment and scan summary before any Google request.")
            return
        }
        let initial = try vault.read(GmailConnection.self, "connection")
        precondition(initial == nil && first.connectedAddress == nil)
        first.start()
        let initialFinding = try await expectResults(first, address: "user1@example.invalid")
        precondition(fixture.counts() == (1,0) && first.connectedAddress == "user1@example.invalid")
        precondition(first.payments.count == 1 && first.pending(for: []).map(\.id) == [initialFinding.id])
        let initialPayment = first.payments[0]
        precondition(initialPayment.amount == Decimal(string: "14.50") && initialPayment.currency == "USD")
        let saved = try vault.read(GmailConnection.self, "connection")
        precondition(saved?.refreshToken == "refresh-1")

        // A new controller reads the cached address, refreshes from Keychain and scans with one action.
        first.close()
        if seed {
            print("The isolated QA process saved its dashboard and exited.")
            return
        }
        let next = EmailScanController(defaults: defaults, oauth: oauth, reader: reader, vault: vault, bundledClient: client)
        precondition(next.connectedAddress == first.connectedAddress && next.storageWarning == nil)
        precondition(next.payments == [initialPayment] && next.lastScanSummary?.inspected == 3)
        let restored = next.pending(for: [])
        precondition(restored.count == 1 && restored[0].id == initialFinding.id)
        precondition(restored[0].subject.isEmpty && restored[0].draft.excerpt.isEmpty)
        precondition(fixture.counts() == (1,0))
        next.start()
        let rescanned = try await expectResults(next, address: "user1@example.invalid")
        precondition(rescanned.id == initialFinding.id && fixture.counts() == (1,1))
        precondition(next.payments == [initialPayment] && next.pending(for: []).count == 1)
        let rotated = try vault.read(GmailConnection.self, "connection")
        precondition(rotated?.refreshToken == "rotated-1")
        let ignored = next.currencyReviews[0]
        try next.dismissCurrencyReview(ignored)
        next.start()
        _ = try await expectResults(next, address: "user1@example.invalid", expectedReviews: 0)
        next.changeAccount()
        let replacement = try await expectResults(next, address: "user2@example.invalid")
        precondition(replacement.id != initialFinding.id && fixture.counts() == (2,2))
        precondition(next.payments.count == 1 && next.payments[0].id != initialPayment.id)
        precondition(next.pending(for: []).map(\.id) == [replacement.id])
        precondition(next.currencyReviews[0].id != ignored.id)
        let secondPayment = next.payments[0]
        let manual = RecordedPayment(id: "qa-manual", service: "QA Paper", amount: 3, currency: "EUR",
                                     day: secondPayment.day, dateSource: .manual)
        try next.recordPayment(manual)
        next.disconnect()
        let disconnected = try vault.read(GmailConnection.self, "connection")
        precondition(next.connectedAddress == nil && disconnected == nil)
        guard case .idle = next.phase else { preconditionFailure("Disconnect did not reset state") }
        precondition(next.payments.isEmpty && next.currencyReviews.isEmpty && next.pending(for: []).isEmpty && next.lastScanAt == nil)
        next.start()
        _ = try await expectResults(next, address: "user2@example.invalid")
        precondition(fixture.counts() == (3,2))
        precondition(Set(next.payments.map(\.id)) == Set([secondPayment.id, manual.id]) && next.payments.count == 2)
        precondition(next.pending(for: []).map(\.id) == [replacement.id])
        try next.excludePayment(secondPayment)
        next.start()
        _ = try await expectResults(next, address: "user2@example.invalid", expectedTotals: [:])
        precondition(next.payments == [manual])
        try next.confirmCurrency(for: next.currencyReviews[0], currency: "CAD")
        precondition(next.currencyReviews.isEmpty && next.payments.count == 2)
        next.start()
        _ = try await expectResults(next, address: "user2@example.invalid", expectedTotals: ["CAD": 4.50], expectedReviews: 0)
        precondition(next.payments.count == 2)
        print("Production controller passed: synthetic Gmail and real loopback/Keychain. The dedicated receipt search supplied a USD 14.50 payment. That payment and a USD 12 monthly plan persisted before rescan, rescanning kept one of each, account switch isolated both, reconnect recovered recorded and manual payments, and the scan total excluded ignored receipts and unrelated manual payments. A bare-dollar payment counted only after confirmation as CAD, with no duplicate on rescan.")
    }
}
