import Foundation

enum MailText {
    static func extract(_ mail: String) throws -> String {
        var body: String?
        var visited = 0
        try visit(mail[...], depth: 0, visited: &visited, found: &body)
        guard let body else { throw ReceiptImportError.unsupportedMail }
        return body
    }

    // Only the visible plain-text body is eligible, including in nested mixed/alternative containers.
    private static func visit(_ entity: Substring, depth: Int, visited: inout Int, found: inout String?) throws {
        visited += 1
        guard depth <= 4, visited <= 64 else { throw ReceiptImportError.unsupportedMail }
        let headers: [String: String]
        let body: Substring
        if entity.first == "\n" {
            headers = [:]
            body = entity.dropFirst()
        } else {
            guard let split = entity.range(of: "\n\n"), entity[..<split.lowerBound].utf8.count <= 65_536 else {
                throw ReceiptImportError.invalidMail
            }
            headers = try readHeaders(entity[..<split.lowerBound])
            body = entity[split.upperBound...]
        }

        let disposition = try headerParts(headers["content-disposition"] ?? "inline")
        guard disposition.name == "inline",
              !disposition.params.keys.contains(where: { $0 == "filename" || $0.hasPrefix("filename*") }) else { return }
        let type = try headerParts(headers["content-type"] ?? "text/plain")
        guard !type.params.keys.contains(where: { $0 == "name" || $0.hasPrefix("name*") }) else { return }

        let encoding = headers["content-transfer-encoding"]?.lowercased() ?? "7bit"
        if ["multipart/alternative", "multipart/mixed"].contains(type.name) {
            guard ["7bit", "8bit"].contains(encoding), let boundary = type.params["boundary"],
                  (1...70).contains(boundary.utf8.count), boundary.utf8.allSatisfy({ (32...126).contains($0) }) else {
                throw ReceiptImportError.invalidMail
            }
            try visitParts(body, boundary: boundary, depth: depth + 1, visited: &visited, found: &found)
            return
        }
        // Forwarded emails, attached documents, HTML and media never contribute candidates.
        guard type.name == "text/plain" else { return }
        guard found == nil else { throw ReceiptImportError.ambiguousMail }
        let charset = type.params["charset"]?.lowercased() ?? "utf-8"
        guard ["utf-8", "us-ascii", "ascii"].contains(charset) else { throw ReceiptImportError.unsupportedMail }
        switch encoding {
        case "7bit", "8bit":
            found = String(body)
        case "base64":
            let compact = body.components(separatedBy: .whitespacesAndNewlines).joined()
            guard let data = Data(base64Encoded: compact), let text = String(data: data, encoding: .utf8) else {
                throw ReceiptImportError.invalidMail
            }
            found = text
        case "quoted-printable":
            guard let text = String(data: try quotedPrintable(String(body)), encoding: .utf8) else {
                throw ReceiptImportError.invalidText
            }
            found = text
        default:
            throw ReceiptImportError.unsupportedMail
        }
    }

    private static func readHeaders(_ section: Substring) throws -> [String: String] {
        var headers: [String: String] = [:]
        var lastKey: String?
        for line in section.split(separator: "\n") {
            if line.first == " " || line.first == "\t" {
                guard let lastKey else { throw ReceiptImportError.invalidMail }
                headers[lastKey, default: ""] += " " + line.trimmingCharacters(in: .whitespaces)
                continue
            }
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
                throw ReceiptImportError.invalidMail
            }
            let key = line[..<colon].lowercased()
            guard key.utf8.allSatisfy({ (33...126).contains($0) }) else { throw ReceiptImportError.invalidMail }
            if key.hasPrefix("content-"), headers[key] != nil { throw ReceiptImportError.invalidMail }
            headers[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            lastKey = key
        }
        return headers
    }

    private static func headerParts(_ raw: String) throws -> (name: String, params: [String: String]) {
        // Preserve case in parameter values, particularly multipart boundaries.
        let parts = raw.components(separatedBy: ";")
        var params: [String: String] = [:]
        for part in parts.dropFirst() {
            guard let equal = part.firstIndex(of: "=") else { continue }
            let key = part[..<equal].trimmingCharacters(in: .whitespaces).lowercased()
            var value = part[part.index(after: equal)...].trimmingCharacters(in: .whitespaces)
            if value.first == "\"", value.last == "\"", value.count >= 2 { value = String(value.dropFirst().dropLast()) }
            guard params[key] == nil else { throw ReceiptImportError.invalidMail }
            params[key] = value
        }
        return (parts[0].trimmingCharacters(in: .whitespaces).lowercased(), params)
    }

    private static func visitParts(_ body: Substring, boundary: String, depth: Int,
                                   visited: inout Int, found: inout String?) throws {
        let marker = "--" + boundary
        var partStart: String.Index?
        var start = body.startIndex
        while start < body.endIndex {
            let end = body[start...].firstIndex(of: "\n") ?? body.endIndex
            let next = end == body.endIndex ? end : body.index(after: end)
            let line = body[start..<end]
            if line.hasPrefix(marker) {
                let suffix = line.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
                if suffix.isEmpty || suffix == "--" {
                    if let partStart {
                        // The line break immediately before the delimiter belongs to the delimiter.
                        let partEnd = start > partStart ? body.index(before: start) : start
                        try visit(body[partStart..<partEnd], depth: depth, visited: &visited, found: &found)
                    }
                    if suffix == "--", partStart != nil { return }
                    partStart = next
                }
            }
            start = next
        }
        throw ReceiptImportError.invalidMail
    }

    private static func quotedPrintable(_ body: String) throws -> Data {
        let input = Array(body.utf8)
        var bytes = Data(capacity: input.count)
        var i = 0
        while i < input.count {
            guard input[i] == 61 else {
                bytes.append(input[i])
                i += 1
                continue
            }
            if i + 1 < input.count, input[i + 1] == 10 {
                i += 2
                continue
            }
            guard i + 2 < input.count, let high = hex(input[i + 1]), let low = hex(input[i + 2]) else {
                throw ReceiptImportError.invalidMail
            }
            bytes.append(high * 16 + low)
            i += 3
        }
        return bytes
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: return byte - 48
        case 65...70: return byte - 55
        case 97...102: return byte - 87
        default: return nil
        }
    }
}
