import Foundation
import Network

/// Google Desktop OAuth redirects to a randomly assigned port on this Mac.
final class GmailLoopback {
    enum Event { case listening(URL), code(String) }
    let events: AsyncThrowingStream<Event, Error>
    private let output: AsyncThrowingStream<Event, Error>.Continuation
    private let listener: NWListener
    private let queue = DispatchQueue(label: "org.renewbefore.gmail-callback")
    private static let signInTimeout: DispatchTimeInterval = .seconds(10 * 60)
    private let state: String
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var finished = false

    init(state: String) throws {
        self.state = state
        let pair = AsyncThrowingStream<Event, Error>.makeStream()
        events = pair.stream
        output = pair.continuation
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [weak self] value in
            guard let self, !self.finished else { return }
            switch value {
            case .ready:
                guard let port = self.listener.port,
                      let url = URL(string: "http://127.0.0.1:\(port.rawValue)") else {
                    self.finish(GmailAuthError.callback); return
                }
                self.output.yield(.listening(url))
            case .failed: self.finish(GmailAuthError.callback)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        queue.asyncAfter(deadline: .now() + Self.signInTimeout) { [weak self] in self?.finish(GmailAuthError.timedOut) }
    }

    func cancel() { queue.async { self.finish(CancellationError()) } }

    private func finish(_ error: Error?) {
        guard !finished else { return }
        finished = true
        listener.cancel()
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        output.finish(throwing: error)
    }

    private func accept(_ connection: NWConnection) {
        guard !finished, connections.count < 8 else { connection.cancel(); return }
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.connections.removeValue(forKey: key)?.cancel()
        }
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] bytes, _, eof, error in
            guard let self, !self.finished, error == nil else { connection.cancel(); return }
            var data = buffer
            if let bytes { data.append(bytes) }
            guard data.count <= 8192 else { connection.cancel(); return }
            if let end = data.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: data[..<end.lowerBound], as: UTF8.self)
                self.respond(connection, head: head)
            } else if !eof { self.read(connection, buffer: data) }
            else { connection.cancel() }
        }
    }

    private func respond(_ connection: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let request = lines.first?.split(separator: " ") ?? []
        let host = "host: 127.0.0.1:\(listener.port?.rawValue ?? 0)"
        let url = request.count == 3 ? URLComponents(string: String(request[1])) : nil
        func unique(_ name: String) -> String? {
            let matches = url?.queryItems?.filter { $0.name == name } ?? []
            return matches.count == 1 ? matches[0].value : nil
        }
        let valid = request.first == "GET" && lines.dropFirst().contains { $0.lowercased() == host }
            && url?.host == nil && url?.path == "/" && unique("state") == state
        let code = valid ? unique("code") : nil
        let denied = valid && unique("error") != nil
        let success = code?.isEmpty == false && !denied
        let message = L10n.text(success ? "Return to Renew Before to view your scan." :
            (denied ? "Sign-in was cancelled. You can return to Renew Before." : "This callback was not accepted."))
        let status = valid && (success || denied) ? "200 OK" : "400 Bad Request"
        let data = Data("HTTP/1.1 \(status)\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: \(message.utf8.count)\r\n\r\n\(message)".utf8)
        connection.send(content: data, completion: .contentProcessed { [weak self] _ in
            connection.cancel()
            guard let self, !self.finished else { return }
            self.connections.removeValue(forKey: ObjectIdentifier(connection))
            if denied { self.finish(GmailAuthError.denied) }
            else if success, let code {
                self.output.yield(.code(code)); self.finish(nil)
            }
        })
    }
}
