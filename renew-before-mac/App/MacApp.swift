import AppKit
import Carbon.HIToolbox
import ServiceManagement
import SwiftUI
import WidgetKit

@main
struct RenewBeforeApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class PanelOptions: ObservableObject {
    @Published var language = L10n.language {
        didSet {
            L10n.language = language
            WidgetCenter.shared.reloadTimelines(ofKind: "RenewBeforeWidget")
        }
    }
    @Published var shortcut = "Menu bar"
    @Published var shortcutHelp = ""
    @Published var loginStatus = SMAppService.mainApp.status
    @Published var loginError: String?

    func toggleLogin() async {
        do {
            if loginStatus == .enabled || loginStatus == .requiresApproval {
                try await SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            loginError = nil
        } catch { loginError = error.localizedDescription }
        loginStatus = SMAppService.mainApp.status
    }
}

private extension Notification.Name {
    static let toggleRenewPanel = Notification.Name("RenewBefore.togglePanel")
}

private final class GlobalShortcut {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?

    func install() -> String? {
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var key = EventHotKeyID()
            guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &key) == noErr,
                  key.signature == 0x52425246, key.id == 1 else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { NotificationCenter.default.post(name: .toggleRenewPanel, object: nil) }
            return noErr
        }, 1, &type, nil, &handler)
        guard status == noErr else { return nil }
        let id = EventHotKeyID(signature: 0x52425246, id: 1)
        let choices = [(cmdKey | optionKey, "⌥⌘R"), (controlKey | optionKey, "⌃⌥R")]
        for (modifiers, label) in choices {
            if RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(modifiers), id, GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &hotKey) == noErr { return label }
        }
        return nil
    }

    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
    }
}

/// A document-style window so a browser or another app can cover it normally.
@MainActor
final class LedgerWindow: NSWindow {
    init(contentSize size: CGSize) {
        super.init(contentRect: CGRect(origin: .zero, size: size),
                   styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "Renew Before"
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isMovableByWindowBackground = true
        isReleasedWhenClosed = false
        level = .normal
        collectionBehavior = [.moveToActiveSpace]
        contentMinSize = CGSize(width: min(520, size.width), height: min(460, size.height))
    }

    override func cancelOperation(_ sender: Any?) {
        if attachedSheet == nil { NSApp.hide(sender) } else { super.cancelOperation(sender) }
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = AppModel()
    private let options = PanelOptions()
    private let hotkey = GlobalShortcut()
    private var panel: LedgerWindow?
    private var statusItem: NSStatusItem?
    private var shortcutObserver: NSObjectProtocol?
    private var languageObserver: NSObjectProtocol?
    private var escapeMonitor: Any?
    private var launched = false
    private var openedByURL = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMainMenu()
        languageObserver = NotificationCenter.default.addObserver(forName: L10n.languageDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.makeMainMenu() }
        }
        if let shortcut = hotkey.install() {
            options.shortcut = shortcut
            if shortcut != "⌥⌘R" { options.shortcutHelp = "⌥⌘R was unavailable. Use ⌃⌥R to show or hide the panel." }
        } else { options.shortcutHelp = "Both shortcuts are unavailable. Click Renew Before in the menu bar to open the panel." }
        shortcutObserver = NotificationCenter.default.addObserver(forName: .toggleRenewPanel, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.togglePanel() }
        }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == UInt16(kVK_Escape), let self, let panel = self.panel,
                  event.window === panel, panel.attachedSheet == nil else { return event }
            NSApp.hide(nil)
            return nil
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "calendar.badge.clock", accessibilityDescription: "Renew Before")
            button.image?.isTemplate = true
            button.toolTip = L10n.format("Renew Before · %@\nRight-click for more options", options.shortcut)
            button.setAccessibilityLabel("Renew Before")
            button.target = self
            button.action = #selector(statusClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        launched = true
        // A login item starts in the menu bar. Explicit launches and widget links open the panel.
        let event = NSAppleEventManager.shared().currentAppleEvent
        let hiddenLaunch = event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        if !hiddenLaunch || openedByURL { showPanel() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.scheme?.lowercased() == "renewbefore" && $0.host?.lowercased() == "open" }) else { return }
        let parts = url.pathComponents
        if parts.count == 3, parts[1] == "review", let id = UUID(uuidString: parts[2]) {
            model.requestedSubscriptionID = id
        }
        openedByURL = true
        if launched { showPanel() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if launched { showPanel() }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        options.loginStatus = SMAppService.mainApp.status
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp || NSApp.currentEvent?.modifierFlags.contains(.control) == true {
            let menu = NSMenu()
            menu.addItem(withTitle: L10n.text("Open Renew Before"), action: #selector(showPanel), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: L10n.text("Quit Renew Before"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.minY - 2), in: sender)
        } else { showPanel() }
    }

    private func togglePanel() {
        if let panel, panel.isVisible, panel.isOnActiveSpace, NSApp.isActive,
           panel.isKeyWindow || panel.attachedSheet?.isKeyWindow == true {
            // Hide the entire app so an open review or sign-in sheet stays attached.
            NSApp.hide(nil)
        } else {
            showPanel()
        }
    }

    @objc private func showPanel() {
        if panel == nil {
            let screen = NSScreen.main?.visibleFrame.size ?? CGSize(width: 900, height: 820)
            let size = CGSize(width: min(710, screen.width - 28), height: min(700, screen.height - 32))
            let window = LedgerWindow(contentSize: size)
            window.contentView = NSHostingView(rootView: LedgerView(model: model, options: options))
            window.setContentSize(size)
            window.center()
            panel = window
        }
        guard let panel else { return }
        model.refresh()
        if NSApp.isHidden { NSApp.unhideWithoutActivation() }
        if panel.isMiniaturized { panel.deminiaturize(nil) }
        NSApp.activate()
        if let sheet = panel.attachedSheet {
            panel.orderFront(nil)
            sheet.makeKeyAndOrderFront(nil)
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private func makeMainMenu() {
        let main = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L10n.text("Quit Renew Before"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(withTitle: "Renew Before", action: nil, keyEquivalent: "").submenu = appMenu
        let edit = NSMenu(title: L10n.text("Edit"))
        for (title, action, key) in [(L10n.text("Undo"), "undo:", "z"), (L10n.text("Cut"), "cut:", "x"), (L10n.text("Copy"), "copy:", "c"), (L10n.text("Paste"), "paste:", "v"), (L10n.text("Select All"), "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        main.addItem(withTitle: L10n.text("Edit"), action: nil, keyEquivalent: "").submenu = edit
        NSApp.mainMenu = main
    }
}
