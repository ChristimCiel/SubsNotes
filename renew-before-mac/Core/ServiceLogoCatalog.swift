import Foundation

/// Presentation metadata only. Never use this catalog to identify payments or change billing facts.
struct ServiceLogo: Decodable {
    let name: String
    let aliases: [String]
    let asset: String?
    let backdrop: String?
}

enum ServiceLogoCatalog {
    private struct Catalog: Decodable { let services: [ServiceLogo] }

    private static var resources: Bundle {
        #if SWIFT_PACKAGE
        return .module
        #else
        return .main
        #endif
    }

    static let services: [ServiceLogo] = {
        guard let url = resources.url(forResource: "service-logo-catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONDecoder().decode(Catalog.self, from: data) else { return [] }
        return catalog.services
    }()

    private static let byName: [String: ServiceLogo] = {
        var result: [String: ServiceLogo] = [:]
        // Curated aliases precede directory names. No fuzzy or substring matching.
        for service in services {
            for alias in [service.name] + service.aliases {
                let key = normalized(alias)
                if !key.isEmpty && result[key] == nil { result[key] = service }
            }
        }
        return result
    }()

    static func logo(for name: String) -> ServiceLogo? { byName[normalized(name)] }

    static func imageURL(for name: String) -> URL? {
        guard let asset = logo(for: name)?.asset else { return nil }
        return imageURL(asset: asset)
    }

    static func imageURL(asset: String) -> URL? {
        // Only catalog filenames resolve; service names are never interpreted as paths or URLs.
        guard asset.hasPrefix("service-logo-"),
              asset.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
        return resources.url(forResource: asset, withExtension: "png", subdirectory: "ServiceLogos")
            ?? resources.url(forResource: asset, withExtension: "png")
    }

    static func initial(for name: String) -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.first.map { String($0).uppercased() } ?? "?"
    }

    static func normalized(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                     locale: Locale(identifier: "en_US_POSIX"))
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"'`\\“”‘’")))
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
