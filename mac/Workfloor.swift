// Workfloor.app: a native window around the Workfloor server.
// The app bundles node and the server; config and data live in ~/Library/Application Support/Workfloor.
// Closing the window keeps the server running so your phone still reaches it; Quit stops it.

import Cocoa
import ServiceManagement
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var port = 4747
    let fm = FileManager.default

    lazy var support: URL = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Workfloor")
    var resources: URL { Bundle.main.resourceURL! }
    var appDir: URL { resources.appendingPathComponent("app") }
    var base: URL { URL(string: "http://localhost:\(port)/")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        prepareHome()
        port = readPort()
        showStatus("Opening the office…")
        DispatchQueue.global().async {
            // A server may already be running (for example `npm start` from the project folder); reuse it.
            if !self.isUp() { self.startServer() }
            let ok = self.waitUntilUp(seconds: 25)
            DispatchQueue.main.async {
                if ok { self.web.load(URLRequest(url: self.base)) }
                else { self.showStatus("The Workfloor server didn't start.<br><small>Log: \(self.support.path)/data/server.log</small>") }
                self.startWatchdog()
            }
        }
    }

    // If the server we reused (say, one started from a terminal) goes away, or ours stops, start ours again.
    var watchdog: Timer?
    func startWatchdog() {
        watchdog = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
            DispatchQueue.global().async {
                if self.isUp() || self.server?.isRunning == true { return }
                self.startServer()
                if self.waitUntilUp(seconds: 25) { DispatchQueue.main.async { self.web.load(URLRequest(url: self.base)) } }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard let p = server, p.isRunning else { return }
        p.interrupt() // the server saves its state on SIGINT
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { p.terminate() }
    }

    // MARK: - Home folder

    func prepareHome() {
        try? fm.createDirectory(at: support, withIntermediateDirectories: true)
        // No config yet: the server writes one from the example and the setup wizard fills it in.
        // First launch: carry over pairing, desks and logs from the project folder if there is one.
        let data = support.appendingPathComponent("data")
        let projectData = fm.homeDirectoryForCurrentUser.appendingPathComponent("workfloor/data")
        if !fm.fileExists(atPath: data.path) && fm.fileExists(atPath: projectData.path) {
            try? fm.copyItem(at: projectData, to: data)
        }
        try? fm.createDirectory(at: data, withIntermediateDirectories: true)
    }

    func readPort() -> Int {
        let url = support.appendingPathComponent("workfloor.config.json")
        guard let raw = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let p = json["port"] as? Int else { return 4747 }
        return p
    }

    // MARK: - Server

    // Apps opened from Finder get a bare PATH. Combine the login shell's PATH, the PATH the app was
    // built with (it has nvm, bun and friends), and the usual tool folders.
    func toolPath() -> String {
        var parts: [String] = []
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "printf %s \"$PATH\""]
        let pipe = Pipe()
        shell.standardOutput = pipe
        shell.standardError = FileHandle.nullDevice
        if (try? shell.run()) != nil {
            let deadline = Date().addingTimeInterval(5)
            while shell.isRunning && Date() < deadline { usleep(50_000) }
            if shell.isRunning { shell.terminate() }
            parts += (String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? "").split(separator: ":").map(String.init)
        }
        if let built = Bundle.main.object(forInfoDictionaryKey: "WorkfloorPath") as? String {
            parts += built.split(separator: ":").map(String.init)
        }
        let home = fm.homeDirectoryForCurrentUser.path
        parts += ["\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        return parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }

    func startServer() {
        let p = Process()
        p.executableURL = resources.appendingPathComponent("node")
        p.arguments = [appDir.appendingPathComponent("server.js").path]
        p.currentDirectoryURL = support
        var env = ProcessInfo.processInfo.environment
        env["WORKFLOOR_HOME"] = support.path
        env["PATH"] = toolPath()
        p.environment = env
        let log = support.appendingPathComponent("data/server.log")
        if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()
            p.standardOutput = handle
            p.standardError = handle
        }
        do { try p.run(); server = p } catch { NSLog("Workfloor: could not start server: \(error)") }
    }

    func isUp() -> Bool {
        var request = URLRequest(url: base.appendingPathComponent("api/state"))
        request.timeoutInterval = 1.5
        let done = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse)?.statusCode == 200
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return ok
    }

    func waitUntilUp(seconds: Double) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if isUp() { return true }
            if let p = server, !p.isRunning { return false }
            usleep(300_000)
        }
        return false
    }

    // MARK: - Window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "workfloor")
        config.applicationNameForUserAgent = "WorkfloorMac"
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Workfloor"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.078, green: 0.094, blue: 0.122, alpha: 1)
        window.minSize = NSSize(width: 380, height: 500)
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("WorkfloorMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func showStatus(_ text: String) {
        web.loadHTMLString("""
            <body style="margin:0;height:100vh;display:grid;place-items:center;background:#14181f;color:#ece6da;
              font:15px -apple-system,sans-serif;text-align:center"><div>🏢<br><br>\(text)</div></body>
            """, baseURL: nil)
    }

    @objc func reload(_ sender: Any?) { web.load(URLRequest(url: base)) }
    @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(base) }
    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.open(support.appendingPathComponent("data/server.log")) }
    @objc func showDataFolder(_ sender: Any?) { NSWorkspace.shared.activateFileViewerSelecting([support.appendingPathComponent("workfloor.config.json")]) }

    // Links to Notion, GitHub and other sites open in the default browser; the floor stays in the window.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, url.scheme?.hasPrefix("http") == true,
           !["localhost", "127.0.0.1"].contains(host) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // The page reports how many desks need you (Dock badge) and when a turn ends (Dock bounce),
    // and reads or flips Open at Login from its settings.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if let needs = body["needs"] as? Int { NSApp.dockTile.badgeLabel = needs > 0 ? "\(needs)" : nil }
        if body["attention"] as? Bool == true { NSApp.requestUserAttention(.informationalRequest) }
        if let on = body["loginItem"] as? Bool { setLoginItem(on) }
        if body["getLoginItem"] as? Bool == true { reportLoginItem() }
        if body["pickFolder"] as? Bool == true { pickFolder() }
    }

    // The setup wizard asks for a repo folder; a real folder picker beats typing a path.
    func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use this repo"
        panel.message = "Pick a git repository Workfloor should work in"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url,
                  let json = try? JSONSerialization.data(withJSONObject: ["folder": url.path]),
                  let arg = String(data: json, encoding: .utf8) else { return }
            self.web.evaluateJavaScript("window.wfMac && window.wfMac(\(arg))")
        }
    }

    var loginItemOn: Bool { SMAppService.mainApp.status == .enabled }

    func setLoginItem(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("Workfloor: login item: \(error)")
        }
        reportLoginItem()
    }

    func reportLoginItem() {
        web.evaluateJavaScript("window.wfMac && window.wfMac({ loginItem: \(loginItemOn) })")
    }

    @objc func toggleLoginItem(_ sender: NSMenuItem) { setLoginItem(!loginItemOn) }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleLoginItem(_:)) { item.state = loginItemOn ? .on : .off }
        return true
    }

    // confirm() and alert() from the page (WebKit drops them unless the app shows them).
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    // MARK: - Menu

    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ build: (NSMenu) -> Void) {
            let item = NSMenuItem()
            let menu = NSMenu(title: title)
            build(menu)
            item.submenu = menu
            main.addItem(item)
        }
        add("Workfloor") { m in
            m.addItem(withTitle: "About Workfloor", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
            m.addItem(.separator())
            m.addItem(withTitle: "Open at Login", action: #selector(toggleLoginItem(_:)), keyEquivalent: "")
            m.addItem(withTitle: "Show Config and Data", action: #selector(showDataFolder(_:)), keyEquivalent: "")
            m.addItem(withTitle: "Show Server Log", action: #selector(showLog(_:)), keyEquivalent: "")
            m.addItem(.separator())
            m.addItem(withTitle: "Hide Workfloor", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
            m.addItem(withTitle: "Quit Workfloor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        }
        add("Edit") { m in
            m.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
            m.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
            m.addItem(.separator())
            m.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
            m.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
            m.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
            m.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        }
        add("View") { m in
            m.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
            m.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "O")
        }
        add("Window") { m in
            m.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
            m.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        }
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
