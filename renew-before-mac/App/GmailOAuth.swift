import AppKit
import CryptoKit
import Security

enum GmailAuthError: LocalizedError {
    case config, keychain, callback, timedOut, denied, expired, browser, token, scope
    var errorDescription: String? {
        switch self {
        case .config: return L10n.text("Choose the downloaded JSON for a Google OAuth Desktop app.")
        case .keychain: return L10n.text("Renew Before couldn’t access its Gmail connection in Keychain. Unlock your login keychain and try again.")
        case .callback: return L10n.text("The local sign-in callback could not start. Close the sign-in window and try again.")
        case .timedOut: return L10n.text("Google sign-in timed out. Scan again to start a new sign-in.")
        case .denied: return L10n.text("Google sign-in was cancelled or access was declined. You can scan again whenever you’re ready.")
        case .expired: return L10n.text("Google needs you to sign in again.")
        case .browser: return L10n.text("The default browser could not open Google sign-in.")
        case .token: return L10n.text("Google could not complete sign-in. Check the Desktop OAuth client and its test-user settings, then try again.")
        case .scope: return L10n.text("Google did not grant Gmail read-only access. Choose that permission when you sign in.")
        }
    }
}

struct GoogleDesktopClient: Codable {
    let client_id: String
    let client_secret: String?
    static func decode(_ data: Data) throws -> Self {
        struct Download: Decodable { let installed: GoogleDesktopClient }
        guard data.count < 65536, let config = try? JSONDecoder().decode(Download.self, from: data).installed,
              config.client_id.hasSuffix(".apps.googleusercontent.com"), config.client_id.count < 260,
              config.client_id.range(of: #"^[a-zA-Z0-9.-]+$"#, options: .regularExpression) != nil,
              (config.client_secret?.count ?? 0) < 512 else { throw GmailAuthError.config }
        return config
    }
}

struct GmailConnection: Codable {
    let clientID: String
    let email: String
    let refreshToken: String
}

struct GmailVault {
    private let service = (Bundle.main.bundleIdentifier ?? "org.renewbefore.mac") + ".gmail"
    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    }
    func read<T: Decodable>(_ type: T.Type, _ account: String) throws -> T? {
        var lookup = query(account)
        lookup[kSecReturnData as String] = true
        var value: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw GmailAuthError.keychain }
        return try JSONDecoder().decode(type, from: data)
    }
    func save<T: Encodable>(_ value: T, _ account: String) throws {
        let data = try JSONEncoder().encode(value)
        let base = query(account)
        var status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw GmailAuthError.keychain }
    }
    func remove(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw GmailAuthError.keychain }
    }
}

private final class TokenRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct GmailOAuth {
    private static let tokenSession = URLSession(configuration: .ephemeral, delegate: TokenRedirectGuard(), delegateQueue: nil)
    private let session: URLSession
    private let openBrowser: @MainActor (URL) -> Bool

    init(session: URLSession? = nil, openBrowser: @escaping @MainActor (URL) -> Bool = { NSWorkspace.shared.open($0) }) {
        self.session = session ?? Self.tokenSession
        self.openBrowser = openBrowser
    }

    static let scope = "https://www.googleapis.com/auth/gmail.readonly"
    struct Tokens: Decodable {
        let access_token: String
        let refresh_token: String?
        let scope: String?
    }
    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw GmailAuthError.token }
        return base64URL(Data(bytes))
    }
    static func base64URL(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func authorizationURL(client: GoogleDesktopClient, redirect: URL, state: String, verifier: String) -> URL {
        var url = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let fields = ["client_id":client.client_id, "redirect_uri":redirect.absoluteString, "scope":scope,
                      "response_type":"code", "access_type":"offline", "prompt":"select_account consent",
                      "state":state, "code_challenge_method":"S256", "code_challenge":challenge]
        url.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        return url.url!
    }
    func authorize(_ client: GoogleDesktopClient) async throws -> Tokens {
        let state = try Self.random(), verifier = try Self.random()
        let callback = try GmailLoopback(state: state)
        defer { callback.cancel() }
        return try await withTaskCancellationHandler {
            var redirect: URL?
            for try await event in callback.events {
                try Task.checkCancellation()
                switch event {
                case .listening(let url):
                    redirect = url
                    let signIn = Self.authorizationURL(client: client, redirect: url, state: state, verifier: verifier)
                    guard await openBrowser(signIn) else { throw GmailAuthError.browser }
                case .code(let code):
                    guard let redirect else { throw GmailAuthError.callback }
                    return try await exchange(client, ["grant_type":"authorization_code", "code":code,
                                                       "redirect_uri":redirect.absoluteString, "code_verifier":verifier])
                }
            }
            throw CancellationError()
        } onCancel: { callback.cancel() }
    }
    func refresh(_ saved: GmailConnection, client: GoogleDesktopClient) async throws -> Tokens {
        try await exchange(client, ["grant_type":"refresh_token", "refresh_token":saved.refreshToken])
    }
    private func exchange(_ client: GoogleDesktopClient, _ values: [String: String]) async throws -> Tokens {
        var fields = values
        fields["client_id"] = client.client_id
        fields["client_secret"] = client.client_secret
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let body = fields.map { $0.key + "=" + ($0.value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "") }.joined(separator: "&")
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
               object["error"] as? String == "invalid_grant", values["grant_type"] == "refresh_token" { throw GmailAuthError.expired }
            throw GmailAuthError.token
        }
        guard let token = try? JSONDecoder().decode(Tokens.self, from: data), !token.access_token.isEmpty else { throw GmailAuthError.token }
        if let scope = token.scope, !scope.split(separator: " ").contains(Substring(Self.scope)) { throw GmailAuthError.scope }
        return token
    }
}
