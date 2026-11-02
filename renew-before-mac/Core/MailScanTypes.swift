import Foundation

struct MailScanAccount: Identifiable, Sendable {
    let id: String
    let name: String
    let address: String
}

/// Temporary input for local discovery. Raw messages do not belong in the subscription ledger.
struct MailScanMessage: Identifiable, Sendable {
    let id: String
    let subject: String
    let sender: String
    let body: String
    let receivedAt: Date
    // Populated only from Gmail's receiving-server authentication result, never receipt text.
    var authenticatedSenderDomain: String? = nil
}

struct MailScanBatch: Sendable {
    let messages: [MailScanMessage]
    let inspected: Int
    let limited: Bool
    let skipped: Int
    var additionalReceiptEmails: Int = 0
    var receiptPDFsUsed: Int = 0
}


enum MailReceiptTerms {
    static let planNames = ["ChatGPT Plus", "ChatGPT Pro", "Claude Pro", "Claude Max", "GitHub Copilot",
                            "YouTube Premium", "Google One", "Microsoft 365", "Creative Cloud", "iCloud+"]
}
