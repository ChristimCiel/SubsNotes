import AppKit

// The runner appends this to the real MacApp.swift after removing its entry point.
enum StoragePaths {
    static func recordsURL() throws -> URL {
        URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("records.json")
    }
}

@main private enum WindowReopenCheck {
    @MainActor static func main() {
        precondition(Bundle.main.bundleIdentifier?.hasPrefix("org.renewbefore.qa.reopen.") == true)
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(500))
            guard let window = app.windows.first(where: { $0 is LedgerWindow }) else {
                preconditionFailure("Explicit launch did not open a ledger window")
            }
            precondition(app.activationPolicy() == .regular && window.isVisible && window.level == .normal)
            window.performClose(nil)
            precondition(!window.isVisible)
            precondition(delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false))
            precondition(window.isVisible && app.windows.filter { $0 is LedgerWindow }.count == 1)
            app.hide(nil)
            try? await Task.sleep(for: .milliseconds(100))
            _ = delegate.applicationShouldHandleReopen(app, hasVisibleWindows: true)
            try? await Task.sleep(for: .milliseconds(100))
            precondition(window.isVisible && !app.isHidden)
            print("PASS real app launch, regular Dock policy, closed-window reopen, hidden-window reopen, single window and normal focus level")
            app.terminate(nil)
        }
        withExtendedLifetime(delegate) { app.run() }
    }
}
