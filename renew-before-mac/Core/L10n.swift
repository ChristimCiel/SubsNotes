import Foundation

enum AppLanguage: String, CaseIterable, Identifiable {
    case english = "en"
    case traditionalChinese = "zh-TW"

    var id: String { rawValue }
    var label: String { self == .english ? "English" : "繁體中文" }
    var locale: Locale { Locale(identifier: self == .english ? "en_US" : "zh_TW") }
    var resourceCode: String { self == .english ? "en" : "zh-Hant" }

    static func resolve(_ value: String?) -> AppLanguage {
        ["zh", "zh-TW", "zh-Hant", "zh-Hant-TW"].contains(value ?? "") ? .traditionalChinese : .english
    }
}

enum L10n {
    static let languageKey = "interfaceLanguage.v1"
    static let languageDidChange = Notification.Name("RenewBefore.languageDidChange")

    private static var preferences: UserDefaults {
        if let group = Bundle.main.object(forInfoDictionaryKey: "RenewBeforeAppGroup") as? String,
           !group.isEmpty, let shared = UserDefaults(suiteName: group) { return shared }
        return .standard
    }

    static var language: AppLanguage {
        get { AppLanguage.resolve(preferences.string(forKey: languageKey)) }
        set {
            preferences.set(newValue.rawValue, forKey: languageKey)
            NotificationCenter.default.post(name: languageDidChange, object: nil)
        }
    }

    static var locale: Locale { language.locale }

    static func text(_ key: String, language: AppLanguage? = nil) -> String {
        #if SWIFT_PACKAGE
        let resources = Bundle.module
        #else
        let resources = Bundle.main
        #endif
        let selected = language ?? self.language
        // SwiftPM toolchains can normalize zh-Hant.lproj to zh-hant.lproj.
        // Resolve the explicit language directory without OS preferred-language filtering.
        for code in [selected.resourceCode, selected.resourceCode.lowercased()] {
            guard let url = resources.resourceURL?.appendingPathComponent(code + ".lproj"),
                  let bundle = Bundle(url: url) else { continue }
            let value = bundle.localizedString(forKey: key, value: key, table: nil)
            if value != key { return value }
        }
        return key
    }

    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: locale, arguments: arguments)
    }

    static func date(_ value: Date, includeTime: Bool = false) -> String {
        value.formatted(Date.FormatStyle(date: .abbreviated, time: includeTime ? .shortened : .omitted).locale(locale))
    }
}
