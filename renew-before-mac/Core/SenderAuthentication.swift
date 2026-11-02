import Foundation

/// Only call with headers returned by Gmail. The top receiving-server result is
/// authoritative. Lower, sender-supplied copies must never qualify a payment.
enum SenderAuthentication {
    static func gmailDomain(results: [String], sender: String) -> String? {
        guard let result = results.first,
              result.range(of: #"^\s*mx\.google\.com\s*;"#, options: [.regularExpression, .caseInsensitive]) != nil,
              let address = sender.range(of: #"(?:<|^)\s*[^<>\s@]+@([A-Za-z0-9.-]+)>?\s*$"#, options: .regularExpression) else { return nil }
        let mailbox = String(sender[address]).trimmingCharacters(in: CharacterSet(charactersIn: " <>\t\r\n"))
        guard let domain = mailbox.split(separator: "@").last?.lowercased() else { return nil }
        let clauses = result.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let dmarc = clauses.filter { $0.lowercased().hasPrefix("dmarc=") }
        guard dmarc.count == 1, let clause = dmarc.first,
              clause.range(of: #"^dmarc=pass\b"#, options: [.regularExpression, .caseInsensitive]) != nil,
              let regex = try? NSRegularExpression(pattern: #"\bheader\.from=([A-Za-z0-9.-]+)(?=\s|$)"#, options: .caseInsensitive) else { return nil }
        let matches = regex.matches(in: clause, range: NSRange(clause.startIndex..., in: clause))
        guard matches.count == 1, let match = matches.first,
              let range = Range(match.range(at: 1), in: clause),
              String(clause[range]).lowercased() == domain else { return nil }
        return domain
    }
}
