import Foundation
import Security

// This harness uses only loopback HTTP and generated test data. --test-keychain
// additionally exercises one unique account, only inside a dedicated QA app bundle.
@main private enum GmailOAuthCheck {
    static func main() async throws {
        let valid = Data(#"{"installed":{"client_id":"123-fixture.apps.googleusercontent.com","client_secret":"fictional"}}"#.utf8)
        let client = try GoogleDesktopClient.decode(valid)
        for invalid in [#"{"web":{"client_id":"123.apps.googleusercontent.com"}}"#,
                        #"{"installed":{"client_id":"abc.invalid"}}"#,
                        #"{"installed":{"client_id":"bad/path.apps.googleusercontent.com"}}"#] {
            do { _ = try GoogleDesktopClient.decode(Data(invalid.utf8)); preconditionFailure("Invalid client accepted") }
            catch GmailAuthError.config {}
        }
        let state = try GmailOAuth.random(), anotherState = try GmailOAuth.random()
        precondition(state != anotherState && state.utf8.count == 43 && state.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil)
        let callback = try GmailLoopback(state: state)
        defer { callback.cancel() }
        var events = callback.events.makeAsyncIterator()
        guard case let .listening(redirect) = try await events.next() else { preconditionFailure("No callback listener") }
        precondition(redirect.host == "127.0.0.1" && redirect.scheme == "http" && (redirect.port ?? 0) > 0)
        // Google's Desktop app spec gives a loopback redirect with no path.
        precondition(redirect.path.isEmpty || redirect.path == "/")

        // RFC 7636 Appendix B known-answer test. No Google endpoint is contacted.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        let auth = GmailOAuth.authorizationURL(client: client, redirect: redirect, state: state, verifier: verifier)
        let fields = URLComponents(url: auth, resolvingAgainstBaseURL: false)!.queryItems!
        func field(_ name: String) -> String? { fields.first { $0.name == name }?.value }
        precondition(auth.scheme == "https" && auth.host == "accounts.google.com")
        precondition(field("code_challenge") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        precondition(field("code_challenge_method") == "S256" && field("state") == state)
        precondition(field("scope") == "https://www.googleapis.com/auth/gmail.readonly")
        precondition(field("redirect_uri") == redirect.absoluteString && field("access_type") == "offline")

        var dest = URLComponents(url: redirect, resolvingAgainstBaseURL: false)!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        func send(_ query: [URLQueryItem]) async throws -> (Int, String) {
            let url = dest.url!.appending(queryItems: query)
            let (data, response) = try await session.data(from: url)
            return ((response as! HTTPURLResponse).statusCode, String(decoding: data, as: UTF8.self))
        }
        let goodState = URLQueryItem(name: "state", value: state)
        let code = URLQueryItem(name: "code", value: "fake/auth+code")
        for invalid in [[URLQueryItem(name: "state", value: "wrong"), code], [goodState, goodState, code], [goodState, code, code]] {
            let result = try await send(invalid)
            precondition(result.0 == 400 && !result.1.contains(state))
        }
        dest.path = "/unexpected"
        let wrongPath = try await send([goodState, code])
        precondition(wrongPath.0 == 400)
        dest = URLComponents(url: redirect, resolvingAgainstBaseURL: false)!
        let accepted = try await send([goodState, code])
        precondition(accepted.0 == 200 && !accepted.1.contains("fake/auth"))
        guard case let .code(returned) = try await events.next() else { preconditionFailure("No code emitted") }
        precondition(returned == code.value)
        let closed = try await events.next(); precondition(closed == nil)

        let deniedCallback = try GmailLoopback(state: state)
        defer { deniedCallback.cancel() }
        var deniedEvents = deniedCallback.events.makeAsyncIterator()
        guard case let .listening(deniedURL) = try await deniedEvents.next() else { preconditionFailure("No listener") }
        dest = URLComponents(url: deniedURL, resolvingAgainstBaseURL: false)!
        let deniedReply = try await send([goodState, .init(name: "error", value: "access_denied")])
        precondition(deniedReply.0 == 200)
        do { _ = try await deniedEvents.next(); preconditionFailure("Consent decline accepted") }
        catch GmailAuthError.denied {}

        print("OAuth passed: config validation, distinct PKCE state, RFC 7636 challenge, loopback address, rejected bad requests, round-trip code, consent decline.")
        if CommandLine.arguments.contains("--test-keychain") {
            guard Bundle.main.bundleIdentifier?.hasPrefix("org.renewbefore.qa.oauth.") == true else {
                preconditionFailure("Keychain check requires its own isolated QA bundle identifier.")
            }
            // No UI prompts, including when a development machine's login keychain is locked.
            SecKeychainSetUserInteractionAllowed(false)
            let key = "qa-" + UUID().uuidString
            let vault = GmailVault()
            let before = try vault.read(String.self, key)
            precondition(before == nil)
            try vault.save("fictional-value", key)
            defer { try? vault.remove(key) }
            let first = try vault.read(String.self, key)
            precondition(first == "fictional-value")
            try vault.save("fictional-update", key)
            let updated = try vault.read(String.self, key)
            precondition(updated == "fictional-update")
            try vault.remove(key)
            let final = try vault.read(String.self, key)
            precondition(final == nil)
            print("Isolated QA Keychain item added, read, updated and removed.")
        }
    }
}
