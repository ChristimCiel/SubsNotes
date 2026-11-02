import AppKit
import Combine

enum EmailScanPhase {
    case idle, connecting, setupRequired
    case scanning(MailScanAccount)
    case results(MailScanAccount, [MailCandidate], MailScanSummary)
    case failed(String)
}

@MainActor final class EmailScanController: ObservableObject {
    @Published private(set) var phase: EmailScanPhase = .idle
    @Published private(set) var connectedAddress: String?
    @Published private(set) var payments: [RecordedPayment] = []
    @Published private(set) var currencyReviews: [PaymentCurrencyReview] = []
    @Published private(set) var paymentReviews: [PaymentReview] = []
    @Published private(set) var storageWarning: String?
    @Published private var inbox = MailReviewInbox()
    private let reviewStore: MailReviewStore
    private let paymentStore: PaymentStore

    var lastScanAt: Date? { inbox.lastScanAt }
    var lastScanSummary: MailScanSummary? { inbox.lastScanSummary }

    private var job: Task<Void, Never>?
    private let vault: GmailVault
    private let oauth: GmailOAuth
    private let reader: GmailReader
    private let bundledClient: GoogleDesktopClient?
    private let defaults: UserDefaults
    private let addressKey = "gmail.connected-address"

    init(defaults: UserDefaults = .standard, oauth: GmailOAuth = GmailOAuth(),
         reader: GmailReader = GmailReader(), vault: GmailVault = GmailVault(),
         bundledClient: GoogleDesktopClient? = nil) {
        self.oauth = oauth
        self.reader = reader
        self.vault = vault
        self.bundledClient = bundledClient
        self.defaults = defaults
        self.reviewStore = MailReviewStore(defaults: defaults)
        self.paymentStore = PaymentStore(defaults: defaults)
        // Only show a cached account label here. Opening the panel never touches Gmail or Keychain.
        self.connectedAddress = defaults.string(forKey: addressKey)
        restoreDashboard()
    }

    func pending(for subscriptions: [Subscription]) -> [MailCandidate] {
        inbox.pending(for: subscriptions)
    }

    func isDismissed(_ candidate: MailCandidate) -> Bool { inbox.isDismissed(candidate) }

    func dismissMatch(_ candidate: MailCandidate) throws {
        guard let address = connectedAddress else { return }
        inbox = try reviewStore.update(mailbox: address) { $0.dismiss(candidate) }
    }

    func recordPayment(_ payment: RecordedPayment) throws {
        let mailbox = connectedAddress ?? ""
        payments = try paymentStore.merge([payment], mailbox: mailbox)
        currencyReviews = try paymentStore.currencyReviews(mailbox: mailbox)
        paymentReviews = try paymentStore.paymentReviews(mailbox: mailbox)
    }

    func excludePayment(_ payment: RecordedPayment) throws {
        payments = try paymentStore.exclude(payment, mailbox: connectedAddress ?? "")
        paymentReviews = try paymentStore.paymentReviews(mailbox: connectedAddress ?? "")
    }

    func confirmPaymentReview(_ review: PaymentReview, optionID: String, currency: String?) throws {
        let mailbox = connectedAddress ?? ""
        payments = try paymentStore.confirmPaymentReview(review, optionID: optionID, currency: currency, mailbox: mailbox)
        paymentReviews = try paymentStore.paymentReviews(mailbox: mailbox)
        currencyReviews = try paymentStore.currencyReviews(mailbox: mailbox)
    }

    func dismissPaymentReview(_ review: PaymentReview) throws {
        let mailbox = connectedAddress ?? ""
        paymentReviews = try paymentStore.dismissPaymentReview(review, mailbox: mailbox)
        payments = try paymentStore.load(mailbox: mailbox)
    }

    func confirmCurrency(for review: PaymentCurrencyReview, currency: String) throws {
        let mailbox = connectedAddress ?? ""
        payments = try paymentStore.confirmCurrency(review, currency: currency, mailbox: mailbox)
        currencyReviews = try paymentStore.currencyReviews(mailbox: mailbox)
    }

    func dismissCurrencyReview(_ review: PaymentCurrencyReview) throws {
        currencyReviews = try paymentStore.dismissCurrencyReview(review, mailbox: connectedAddress ?? "")
    }

    func start() { run(switchAccount: false) }
    func changeAccount() { run(switchAccount: true) }
    func cancel() { job?.cancel(); job = nil; phase = .idle }
    func close() { cancel() }

    func useClientFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size < 65536 else { throw GmailAuthError.config }
            let client = try GoogleDesktopClient.decode(Data(contentsOf: url))
            try vault.save(client, "desktop-client")
            start()
        } catch { phase = .failed(error.localizedDescription) }
    }

    func disconnect() {
        cancel()
        do {
            try vault.remove("connection")
            if let connectedAddress { reviewStore.forget(mailbox: connectedAddress) }
            setAddress(nil)
        }
        catch { phase = .failed(error.localizedDescription) }
    }

    private func client() throws -> GoogleDesktopClient? {
        if let bundledClient { return bundledClient }
        if let url = Bundle.main.url(forResource: "GmailDesktopClient", withExtension: "json") {
            return try GoogleDesktopClient.decode(Data(contentsOf: url))
        }
        return try vault.read(GoogleDesktopClient.self, "desktop-client")
    }

    private func setAddress(_ address: String?) {
        connectedAddress = address
        defaults.set(address, forKey: addressKey)
        restoreDashboard()
    }

    private func restoreDashboard() {
        inbox = MailReviewInbox()
        payments = []
        currencyReviews = []
        paymentReviews = []
        var issues: [String] = []
        if let connectedAddress {
            do { inbox = try reviewStore.load(mailbox: connectedAddress) }
            catch { issues.append(error.localizedDescription) }
        }
        do {
            let mailbox = connectedAddress ?? ""
            payments = try paymentStore.load(mailbox: mailbox)
            currencyReviews = try paymentStore.currencyReviews(mailbox: mailbox)
            paymentReviews = try paymentStore.paymentReviews(mailbox: mailbox)
        } catch { issues.append(error.localizedDescription) }
        storageWarning = issues.isEmpty ? nil : issues.joined(separator: " ")
    }

    private func run(switchAccount: Bool) {
        cancel()
        job = Task {
            do {
                try Task.checkCancellation()
                guard let client = try client() else { phase = .setupRequired; return }
                let saved = try vault.read(GmailConnection.self, "connection")
                if !switchAccount, let saved, saved.clientID == client.client_id {
                    phase = .scanning(account(saved.email))
                    do {
                        let token = try await oauth.refresh(saved, client: client)
                        try Task.checkCancellation()
                        if let rotated = token.refresh_token {
                            try vault.save(GmailConnection(clientID: client.client_id, email: saved.email, refreshToken: rotated), "connection")
                        }
                        if connectedAddress != saved.email { setAddress(saved.email) }
                        try await scan(email: saved.email, token: token.access_token)
                        return
                    } catch GmailAuthError.expired {
                        try Task.checkCancellation()
                    } catch GmailReadError.unauthorized {
                        try Task.checkCancellation()
                    }
                }
                phase = .connecting
                let token = try await oauth.authorize(client)
                try Task.checkCancellation()
                let email = try await reader.emailAddress(accessToken: token.access_token)
                try Task.checkCancellation()
                guard let refresh = token.refresh_token, !refresh.isEmpty else { throw GmailAuthError.token }
                try vault.save(GmailConnection(clientID: client.client_id, email: email, refreshToken: refresh), "connection")
                setAddress(email)
                try await scan(email: email, token: token.access_token)
            } catch {
                if !Task.isCancelled { phase = .failed(error.localizedDescription) }
            }
        }
    }

    private func account(_ email: String) -> MailScanAccount {
        MailScanAccount(id: email, name: email, address: email)
    }

    private func scan(email: String, token: String) async throws {
        let selected = account(email)
        phase = .scanning(selected)
        let batch = try await reader.scan(accessToken: token)
        try Task.checkCancellation()
        let (findings, financial) = await Task.detached(priority: .userInitiated) {
            (MailDiscovery.candidates(from: batch.messages, mailbox: email),
             PaymentDiscovery.scan(from: batch.messages, mailbox: email))
        }.value
        try Task.checkCancellation()
        var summary = MailScanSummary(inspected: batch.inspected, limited: batch.limited, skipped: batch.skipped,
                                      additionalReceiptEmails: batch.additionalReceiptEmails, receiptPDFsUsed: batch.receiptPDFsUsed)
        do {
            payments = try paymentStore.merge(financial.payments, reviews: financial.currencyReviews, paymentReviews: financial.paymentReviews, mailbox: email)
            currencyReviews = try paymentStore.currencyReviews(mailbox: email)
            paymentReviews = try paymentStore.paymentReviews(mailbox: email)
            // Include a previously ambiguous receipt if the user has since confirmed its currency.
            let receiptIDs = Set(financial.payments.map(\.id)).union(financial.currencyReviews.map(\.id))
            let included = payments.filter { receiptIDs.contains($0.id) }
            summary.unresolvedCurrencyCount = currencyReviews.filter { receiptIDs.contains($0.id) }.count
            summary.recordedCount = included.count
            summary.recordedTotals = included.reduce(into: [String: Decimal]()) { totals, payment in
                totals[payment.currency, default: .zero] += payment.amount
            }
            inbox = try reviewStore.update(mailbox: email) { $0.merge(findings, at: Date(), summary: summary) }
            storageWarning = nil
        } catch {
            storageWarning = error.localizedDescription
            throw error
        }
        phase = .results(selected, findings, summary)
    }
}
