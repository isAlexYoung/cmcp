import AppKit
import WebKit
import ServiceManagement
import Foundation
import CoreGraphics
import ApplicationServices

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSMenuDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var item: NSStatusItem!
    var process: Process?
    var origin = "", token = "", pendingOutput = Data()
    var language = "zh-CN", closeAction = "tray"
    var exitApproved = false, exitPending = false, uninstalling = false, ready = false, startup: Bool, testing: Bool
    var reportDirectory: URL?, testResults: [String] = [], motionResults: [String] = [], reducedMotion = false
    var updateRequest: URL?
    var testStderr = Data()
    var crashTimes: [Date] = []
    var trayTargets: [[String: Any]] = [], trayRows: [String: NSMenuItem] = [:], trayOrder: [String] = []
    var trayTimer: Timer?, trayRefreshing = false, trayTracking = false, trayUpdating = false
    var trayMenu: NSMenu!
    var trayPending = Set<String>()
    let bundle = Bundle.main
    var stateDirectory: URL
    var resources: URL { bundle.resourceURL! }
    init(arguments: [String]) {
        startup = arguments.contains("--startup")
        testing = arguments.contains("--self-test")
        if let custom = ProcessInfo.processInfo.environment["CMCP_STATE_DIR"], !custom.isEmpty { stateDirectory = URL(fileURLWithPath: custom, isDirectory: true) }
        else { stateDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CMCP", isDirectory: true) }
        if testing {
            let index = arguments.firstIndex(of: "--self-test")!
            if index + 1 < arguments.count { reportDirectory = URL(fileURLWithPath: arguments[index + 1], isDirectory: true) }
            stateDirectory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("MacCMCP-" + UUID().uuidString, isDirectory: true)
        }
        super.init()
        if let index = arguments.firstIndex(of: "--updated"), index + 1 < arguments.count { updateRequest = URL(fileURLWithPath: arguments[index + 1]) }
    }
    func tr(_ zh: String, _ en: String) -> String { language == "en" ? en : zh }
    // SMAppService passes no arguments; a login item is told apart by the open event's 'lgit' value.
    static func launchedAtLogin(_ event: NSAppleEventDescriptor?) -> Bool {
        event?.eventID == 0x6F617070 /* oapp */ && event?.paramDescriptor(forKeyword: 0x70726F70 /* prop */)?.enumCodeValue == 0x6C676974 /* lgit */
    }
    // The page colour of style.css. Until WebKit paints, on first load or when the window comes back
    // from the menu bar or the Dock, the window shows this instead of WebKit's white.
    static let pageColor = NSColor(name: "CMCPPage") { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0x14 / 255.0, green: 0x17 / 255.0, blue: 0x1b / 255.0, alpha: 1) : .white
    }
    // Tray state colours: 1 connected, 2 SSH, anything else muted.
    static func tone(_ tone: Int) -> NSColor { tone == 1 ? .systemGreen : tone == 2 ? .systemBlue : .secondaryLabelColor }
    static func symbol(_ name: String) -> NSImage? {
        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .regular)); image?.isTemplate = true; return image
    }
    static func dot(_ color: NSColor) -> NSImage {
        NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in color.setFill(); NSBezierPath(ovalIn: NSRect(x: 4.5, y: 4.5, width: 7, height: 7)).fill(); return true }
    }
    func hideWindow() { window.orderOut(nil); NSApp.setActivationPolicy(.accessory) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if App.launchedAtLogin(NSAppleEventManager.shared().currentAppleEvent) { startup = true }
        if !testing, let identifier = bundle.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: {
               guard $0.processIdentifier != ProcessInfo.processInfo.processIdentifier, $0.bundleURL?.standardizedFileURL == bundle.bundleURL.standardizedFileURL else { return false }
               let previous = $0.launchDate ?? Date.distantPast, current = NSRunningApplication.current.launchDate ?? Date.distantPast
               return previous < current || (previous == current && $0.processIdentifier < ProcessInfo.processInfo.processIdentifier)
           }) {
            if !startup {
                DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("com.cmcp.manager.restore"), object: bundle.bundleURL.standardizedFileURL.path, userInfo: nil, deliverImmediately: true)
                existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            }
            exitApproved = true; NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(startup ? .accessory : .regular)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "cmcp")
        if testing { configuration.userContentController.addUserScript(WKUserScript(source: "window.CMCP_TEST=true", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "CMCP"; window.minSize = NSSize(width: 660, height: 500); window.center(); window.delegate = self
        window.contentView = web; window.isReleasedWhenClosed = false; window.backgroundColor = App.pageColor
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(restoreExistingWindow(_:)), name: NSNotification.Name("com.cmcp.manager.restore"), object: bundle.bundleURL.standardizedFileURL.path)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "CMCP")
        // A left click opens the main window; a right click or Control-click shows the menu.
        item.button?.target = self; item.button?.action = #selector(trayClick(_:)); item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        rebuildMenu()
        if !startup { show() }
        do {
            if testing {
                try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let targets: [[String: Any]] = ["desktop1.example.com", "desktop2.example.com"].enumerated().map { index, host in
                    ["id": UUID().uuidString.lowercased(), "url": "https://" + host, "label": "Mac " + String(index + 1), "authMode": "shared-browser", "autoLogin": false, "changed": UUID().uuidString]
                }
                let config: [String: Any] = ["targets": targets, "roots": [stateDirectory.path]]
                try JSONSerialization.data(withJSONObject: config).write(to: stateDirectory.appendingPathComponent("targets.json"))
            }
            startBackend()
            if testing {
                guard window.isVisible && !ready else { finishTests(error: "The native window must appear before backend readiness"); return }
                testResults.append("native window appears before asynchronous backend readiness")
            }
        } catch { fail("无法准备运行环境。") }
    }
    func rebuildMenu() {
        if trayMenu == nil {
            let menu = NSMenu(); menu.delegate = self; menu.autoenablesItems = false; menu.appearance = nil
            menu.addItem(withTitle: "", action: #selector(show), keyEquivalent: "").target = self
            menu.addItem(.separator()); menu.addItem(.separator())
            menu.addItem(withTitle: "", action: #selector(quit), keyEquivalent: "").target = self
            menu.items.first?.image = App.symbol("macwindow"); menu.items.last?.image = App.symbol("power")
            trayMenu = menu
        }
        updateTrayMenu()
        let main = NSMenu(), appMenu = NSMenu(), top = NSMenuItem()
        appMenu.addItem(withTitle: tr("退出程序", "Exit application"), action: #selector(quit), keyEquivalent: "q").target = self
        top.submenu = appMenu; main.addItem(top)
        let edit = NSMenu(), editTop = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        for (title, selector, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        editTop.submenu = edit; main.addItem(editTop); NSApp.mainMenu = main
    }
    func trayState(_ state: String) -> String {
        let names = ["connected": ("已连接", "Connected"), "recovering": ("正在恢复", "Recovering"), "unstable": ("正在恢复", "Recovering"), "connecting": ("连接中", "Connecting"), "configuring": ("正在配置 Claude", "Setting up Claude"), "waiting-login": ("等待网页登录", "Waiting for browser sign-in"), "offline": ("等待网络恢复", "Waiting for network"), "replaced": ("连接已被接管", "Connection replaced"), "password": ("需要更新密码", "Update password"), "locked": ("登录暂时锁定", "Sign-in locked"), "expired": ("访问已过期", "Access expired"), "stale": ("状态已过期", "Status unavailable"), "stopped": ("已停止", "Stopped")]
        let value = names[state] ?? ("连接异常", "Connection error"); return tr(value.0, value.1)
    }
    func updateTrayMenu() {
        guard let menu = trayMenu else { return }
        menu.items.first?.title = tr("打开主界面", "Open main window"); menu.items.last?.title = tr("退出程序", "Exit application")
        let ids = trayTargets.compactMap { $0["id"] as? String }
        if ids != trayOrder && !trayTracking {
            while menu.items.count > 4 { menu.removeItem(at: 2) }
            trayRows = trayRows.filter { ids.contains($0.key) }
            for (index, id) in ids.enumerated() {
                if trayRows[id] == nil {
                    let row = NSMenuItem(title: "", action: nil, keyEquivalent: ""), sub = NSMenu()
                    sub.autoenablesItems = false; sub.appearance = nil
                    for (selector, symbol) in [(#selector(trayConnect(_:)), "play"), (#selector(trayDisconnect(_:)), "stop"), (#selector(trayRename(_:)), "pencil")] {
                        let command = NSMenuItem(title: "", action: selector, keyEquivalent: ""); command.target = self; command.representedObject = id; command.image = App.symbol(symbol); sub.addItem(command)
                    }
                    // Switches between the shared web page and SSH, like the switch on the card.
                    sub.addItem(.separator())
                    let change = NSMenuItem(title: "", action: #selector(traySwitch(_:)), keyEquivalent: ""); change.target = self; change.representedObject = id; sub.addItem(change)
                    row.submenu = sub; trayRows[id] = row
                }
                menu.insertItem(trayRows[id]!, at: index + 2)
            }
            trayOrder = ids
        }
        if ids.isEmpty && !trayTracking && menu.items.count == 4 { let empty = NSMenuItem(title: "", action: nil, keyEquivalent: ""); empty.identifier = NSUserInterfaceItemIdentifier("empty"); empty.isEnabled = false; menu.insertItem(empty, at: 2) }
        if let empty = menu.items.first(where: { $0.identifier?.rawValue == "empty" }) { empty.title = tr("暂无设备", "No devices") }
        // Names sit on the left and states line up on the right, like the Windows tray.
        let font = NSFont.menuFont(ofSize: 14), small = NSFont.menuFont(ofSize: 13)
        let rows: [(target: [String: Any], id: String, label: String, state: String, tone: Int)] = trayTargets.compactMap { target in
            guard let id = target["id"] as? String else { return nil }
            let state = target["state"] as? String ?? "stopped", enabled = target["enabled"] as? Bool == true, ssh = target["ssh"] as? Bool == true
            return (target, id, target["label"] as? String ?? "CMCP", ssh && !enabled ? "SSH" : trayState(state), ssh && !enabled ? 2 : state == "connected" ? 1 : 0)
        }
        let column = max(220, rows.map { ($0.label as NSString).size(withAttributes: [.font: font]).width + ($0.state as NSString).size(withAttributes: [.font: small]).width + 36 }.max() ?? 0)
        for shown in rows {
            guard let row = trayRows[shown.id], let sub = row.submenu else { continue }
            let target = shown.target, id = shown.id, state = target["state"] as? String ?? "stopped", enabled = target["enabled"] as? Bool == true
            let ssh = target["ssh"] as? Bool == true
            row.title = shown.label + " · " + shown.state; row.toolTip = row.title
            let paragraph = NSMutableParagraphStyle(); paragraph.tabStops = [NSTextTab(textAlignment: .right, location: ceil(column))]; paragraph.lineBreakMode = .byTruncatingMiddle
            let title = NSMutableAttributedString(string: shown.label + "\t", attributes: [.font: font, .paragraphStyle: paragraph])
            title.append(NSAttributedString(string: shown.state, attributes: [.font: small, .paragraphStyle: paragraph, .foregroundColor: App.tone(shown.tone)]))
            row.attributedTitle = title; row.image = App.dot(shown.tone == 0 ? .tertiaryLabelColor : App.tone(shown.tone))
            let active = ["connected", "connecting", "configuring", "waiting-login", "recovering", "unstable"].contains(state)
            let blocked = !ready || exitPending || trayUpdating || trayPending.contains(id)
            sub.items[0].title = tr("连接设备", "Connect device"); sub.items[0].isEnabled = !blocked && (ssh || !active)
            sub.items[1].title = tr("断开设备", "Disconnect device"); sub.items[1].isEnabled = !blocked && enabled
            sub.items[2].title = tr("重命名", "Rename"); sub.items[2].isEnabled = !blocked
            let cloud = target["loginMode"] as? String == "cloudcli"
            sub.items[4].title = cloud ? tr("切换为 SSH 登录", "Switch to SSH sign-in") : ssh ? tr("切换为网页桌面登录", "Switch to web desktop sign-in") : tr("切换为 CloudCLI 登录", "Switch to CloudCLI sign-in")
            sub.items[4].image = App.symbol(cloud ? "terminal" : "globe"); sub.items[4].isEnabled = !blocked
        }
    }
    func refreshTray(_ completion: (() -> Void)? = nil) {
        guard ready, !trayRefreshing, !exitPending else { return }
        trayRefreshing = true; let address = origin
        request("/api/tray", [:]) { [weak self] result in
            guard let self = self else { return }; self.trayRefreshing = false
            guard self.origin == address else { return }
            switch result {
            case .success(let value):
                if let targets = value["targets"] as? [[String: Any]], targets.count <= 100 {
                    self.trayTargets = targets.filter { target in guard let id = target["id"] as? String, UUID(uuidString: id) != nil, let label = target["label"] as? String else { return false }; return label.count <= 512 && !label.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }
                    self.trayUpdating = value["updating"] as? Bool == true
                    if let language = value["language"] as? String { self.language = language == "en" ? "en" : "zh-CN" }
                }
            case .failure:
                self.trayTargets = self.trayTargets.map { var target = $0; if target["enabled"] as? Bool == true { target["state"] = "stale" }; return target }
            }
            self.updateTrayMenu(); completion?()
        }
    }
    func menuNeedsUpdate(_ menu: NSMenu) { if menu === trayMenu && !trayTracking { updateTrayMenu() } }
    func menuWillOpen(_ menu: NSMenu) { if menu === trayMenu { trayTracking = true; refreshTray() } }
    func menuDidClose(_ menu: NSMenu) { if menu === trayMenu { trayTracking = false; item.menu = nil; updateTrayMenu() } }
    @objc func trayClick(_ sender: Any?) {
        guard let event = NSApp.currentEvent, event.type == .rightMouseUp || event.modifierFlags.contains(.control) else { show(); return }
        // The menu is attached only while it is open, so it keeps the native position under the icon.
        item.menu = trayMenu; item.button?.performClick(nil); item.menu = nil
    }
    func trayAction(_ sender: NSMenuItem, route: String) {
        guard let id = sender.representedObject as? String, let row = trayRows[id], let sub = row.submenu else { return }
        let index = route == "stop" ? 1 : route == "login" ? 4 : 0; guard sub.items[index].isEnabled else { return }
        trayPending.insert(id); updateTrayMenu()
        var body: [String: Any] = ["id": id]
        if route == "login" { let target = trayTargets.first { $0["id"] as? String == id }; let mode = target?["loginMode"] as? String ?? (target?["ssh"] as? Bool == true ? "ssh" : "web"); body["mode"] = mode == "cloudcli" ? "ssh" : mode == "ssh" ? "web" : "cloudcli" }
        request("/api/targets/" + route, body) { [weak self] result in
            guard let self = self else { return }; self.trayPending.remove(id)
            if case .failure = result { self.show(); self.web.evaluateJavaScript("window.cmcpTrayError()", completionHandler: nil) }
            self.refreshTray()
        }
    }
    @objc func trayConnect(_ sender: NSMenuItem) {
        let ssh = trayTargets.first { $0["id"] as? String == sender.representedObject as? String }?["ssh"] as? Bool == true
        trayAction(sender, route: ssh ? "terminal" : "start")
    }
    @objc func trayDisconnect(_ sender: NSMenuItem) { trayAction(sender, route: "stop") }
    @objc func traySwitch(_ sender: NSMenuItem) { trayAction(sender, route: "login") }
    @objc func trayRename(_ sender: NSMenuItem) {
        guard sender.isEnabled, let id = sender.representedObject as? String, let bytes = try? JSONSerialization.data(withJSONObject: [id]), let args = String(data: bytes, encoding: .utf8) else { return }
        show(); web.evaluateJavaScript("window.cmcpRenameTarget(..." + args + ")", completionHandler: nil)
    }
    func startBackend() {
        if exitPending || exitApproved { return }
        let child = Process(), output = Pipe(), errors = Pipe()
        child.executableURL = resources.appendingPathComponent("runtime/node")
        child.arguments = ["--use-system-ca", resources.appendingPathComponent("macos/desktop.mjs").path]
        var environment = ProcessInfo.processInfo.environment
        for name in ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD"] { environment.removeValue(forKey: name) }
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["CMCP_STATE_DIR"] = stateDirectory.path
        environment["CMCP_FORCE_RESTART"] = updateRequest == nil ? "0" : "1"
        if testing { environment["CMCP_NATIVE_SELF_TEST"] = "1" }
        child.environment = environment; child.currentDirectoryURL = resources
        child.standardOutput = output; child.standardError = errors
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            DispatchQueue.main.async { if self?.testing == true, (self?.testStderr.count ?? 0) < 32768 { self?.testStderr.append(bytes) } }
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            DispatchQueue.main.async { self?.consume(bytes) }
        }
        child.terminationHandler = { [weak self] child in DispatchQueue.main.async {
            guard let self = self else { return }
            if self.exitApproved || self.uninstalling { return }
            if self.exitPending { self.exitApproved = true; NSApp.reply(toApplicationShouldTerminate: true); return }
            if !self.ready { self.fail("后台未能启动，请检查应用完整性。 status=" + String(child.terminationStatus)); return }
            if child.terminationStatus != 0 && !self.testing {
                self.crashTimes = self.crashTimes.filter { Date().timeIntervalSince($0) < 60 }
                if self.crashTimes.count < 2 {
                    self.crashTimes.append(Date()); self.ready = false; self.pendingOutput = Data()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.startBackend() }
                    return
                }
                self.fail(self.tr("后台连续异常退出，请重新打开应用。", "The backend stopped repeatedly. Reopen the app.")); return
            }
            self.exitApproved = true; NSApp.terminate(nil)
        } }
        process = child
        do { try child.run() } catch { fail("无法启动内置后台，请完整解压应用。"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self, self.process === child, !self.ready else { return }
            if self.exitPending { child.terminate() } else { self.fail("后台启动超时。") }
        }
    }
    func consume(_ bytes: Data) {
        pendingOutput.append(bytes)
        if pendingOutput.count > 65536 { fail("后台响应无效。"); return }
        while let end = pendingOutput.firstIndex(of: 10) {
            let line = pendingOutput[..<end]; pendingOutput.removeSubrange(...end)
            guard !ready, let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let address = value["origin"] as? String, let secret = value["token"] as? String,
                  let url = URL(string: address), url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
                  secret.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { continue }
            origin = address; token = secret; ready = true
            if exitPending { finishExit(); return }
            trayTimer?.invalidate(); trayTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refreshTray() }
            if let timer = trayTimer { RunLoop.main.add(timer, forMode: .common) }; refreshTray()
            web.load(URLRequest(url: URL(string: address + "/#" + secret)!))
            if startup { hideWindow() }
        }
    }
    @objc func show() { NSApp.setActivationPolicy(.regular); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func restoreExistingWindow(_ notification: Notification) { DispatchQueue.main.async { self.show() } }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return false }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeAction == "tray" { hideWindow() } else { quit() }
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if exitApproved { return .terminateNow }
        if exitPending { return .terminateLater }
        if !ready && process?.isRunning != true { exitApproved = true; return .terminateNow }
        exitPending = true
        if ready { finishExit() }
        return .terminateLater
    }
    func finishExit() {
        request("/api/exit", [:]) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.exitApproved = true
                self.process?.terminate()
                NSApp.reply(toApplicationShouldTerminate: true)
            case .failure:
                self.exitPending = false; NSApp.reply(toApplicationShouldTerminate: false)
                self.alert(self.tr("未能确认全部连接已停止，请重试退出。", "Could not confirm all connections have stopped. Try exiting again."))
            }
        }
    }
    func applicationWillTerminate(_ notification: Notification) { DistributedNotificationCenter.default().removeObserver(self); trayTimer?.invalidate(); if process?.isRunning == true { process?.terminate() }; if let item = item { NSStatusBar.system.removeStatusItem(item) } }
    func request(_ route: String, _ body: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let url = URL(string: origin + route), !token.isEmpty else { completion(.failure(NSError(domain: "CMCP", code: 1))); return }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = route.contains("update") ? 900 : route == "/api/uninstall" ? 170 : route == "/api/tray" ? 5 : 20
        request.setValue(token, forHTTPHeaderField: "x-cmcp-token"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { data, response, error in DispatchQueue.main.async {
            if let error = error { completion(.failure(error)); return }
            guard let response = response as? HTTPURLResponse, response.statusCode == 200, let data = data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { completion(.failure(NSError(domain: "CMCP", code: 2))); return }
            completion(.success(object))
        } }.resume()
    }
    func reply(_ id: Int, _ value: Any = NSNull(), error: String? = nil) {
        guard JSONSerialization.isValidJSONObject([id, value, error as Any? ?? NSNull()]),
              let bytes = try? JSONSerialization.data(withJSONObject: [id, value, error as Any? ?? NSNull()]),
              let args = String(data: bytes, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.cmcpNativeReply(..." + args + ")", completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "http", message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == URL(string: origin)?.port,
              let body = message.body as? [String: Any], let id = body["id"] as? Int, let action = body["action"] as? String else { return }
        let value = body["payload"] as? [String: Any] ?? [:]
        switch action {
        case "preferences":
            language = value["language"] as? String ?? "zh-CN"; closeAction = value["closeAction"] as? String == "exit" ? "exit" : "tray"
            let theme = value["theme"] as? String ?? "system"
            window.appearance = theme == "system" ? nil : NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
            rebuildMenu(); reply(id, true)
        case "ready":
            reply(id, true)
            if testing {
                request("/api/tray", [:]) { [weak self] result in guard let self = self else { return }; if case .success(let value) = result, let targets = value["targets"] as? [[String: Any]] { self.trayTargets = targets; self.updateTrayMenu(); self.runTests() } else { self.finishTests(error: "Tray snapshot unavailable") } }
            }
            else if let file = updateRequest {
                if stateDirectory.standardizedFileURL == file.deletingLastPathComponent().standardizedFileURL,
                   let bytes = try? Data(contentsOf: file), let values = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                   values["installRoot"] as? String == bundle.bundleURL.path, let nonce = values["nonce"] as? String {
                    try? Data(nonce.utf8).write(to: URL(fileURLWithPath: file.path + ".ack"), options: .atomic)
                }
            } else if !startup { warnIfNotInstalled() }
        case "open":
            guard let text = value["url"] as? String, let url = URL(string: text), ["https", "http"].contains(url.scheme), url.user == nil, url.password == nil,
                  url.scheme == "https" || url.host == "127.0.0.1" else { reply(id, error: "Invalid URL"); return }
            reply(id, NSWorkspace.shared.open(url))
        case "icons":
            // Each browser's own Finder icon for the settings dropdown; "default" is the app that opens web links now.
            // The page names browsers only by id, so no local path ever reaches it.
            let bundles = ["safari": "com.apple.Safari", "chrome": "com.google.Chrome", "edge": "com.microsoft.edgemac", "firefox": "org.mozilla.firefox"]
            var icons: [String: String] = [:]
            for name in (value["ids"] as? [String] ?? []).prefix(8) {
                let app: URL?
                if name == "default" { app = URL(string: "https://example.com").flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) } }
                else { app = bundles[name].flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) } }
                guard let file = app?.path,
                      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
                NSWorkspace.shared.icon(forFile: file).draw(in: NSRect(x: 0, y: 0, width: 40, height: 40))
                NSGraphicsContext.restoreGraphicsState()
                if let png = bitmap.representation(using: .png, properties: [:]) { icons[name] = "data:image/png;base64," + png.base64EncodedString() }
            }
            reply(id, icons)
        case "copy":
            guard let text = value["text"] as? String, text.count < 8192 else { reply(id, error: "Invalid text"); return }
            NSPasteboard.general.clearContents(); reply(id, NSPasteboard.general.setString(text, forType: .string))
        case "confirm":
            let alert = NSAlert(); alert.messageText = String((value["text"] as? String ?? "").prefix(200)); alert.addButton(withTitle: tr("确定", "Confirm")); alert.addButton(withTitle: tr("取消", "Cancel"))
            reply(id, alert.runModal() == .alertFirstButtonReturn)
        case "pickKey":
            let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.showsHiddenFiles = true
            panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh"); panel.message = tr("选择私钥文件", "Choose a private key file")
            panel.begin { [weak self] response in self?.reply(id, response == .OK ? (panel.url?.path ?? "") : "") }
        case "logs":
            reply(id, NSWorkspace.shared.open(stateDirectory))
        case "program":
            NSWorkspace.shared.activateFileViewerSelecting([bundle.bundleURL]); reply(id, true)
        case "shortcut":
            do { try createShortcut(); reply(id, true) } catch { reply(id, error: tr("快捷方式未能创建。", "Could not create the shortcut.")) }
        case "autostart":
            if testing { reply(id, true); return }
            Task { @MainActor in
                do {
                    if value["enabled"] as? Bool == true { try await SMAppService.mainApp.register() } else { try await SMAppService.mainApp.unregister() }
                    if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
                    reply(id, true)
                } catch { reply(id, error: tr("开机自启设置失败，请检查登录项权限。", "Could not change login settings. Check Login Items permissions.")) }
            }
        case "uninstall":
            uninstalling = true
            request("/api/uninstall", ["appPid": ProcessInfo.processInfo.processIdentifier]) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success(let value):
                    self.reply(id, true)
                    Task { @MainActor in
                        try? await SMAppService.mainApp.unregister()
                        if let failed = value["cloudFailed"] as? Int, failed > 0 {
                            self.alert(self.tr("CMCP 已卸载，但有 \(failed) 台云电脑上的 Claude 配置未能移除。", "CMCP was uninstalled, but the Claude configuration could not be removed from \(failed) cloud PC(s)."))
                        }
                        self.exitApproved = true; NSApp.terminate(nil)
                    }
                case .failure:
                    self.uninstalling = false
                    if self.process?.isRunning != true { self.exitApproved = true; NSApp.terminate(nil); return }
                    self.reply(id, error: self.tr("卸载失败。请确认你有权限修改 CMCP 所在的文件夹，然后重试。", "Could not uninstall. Check that you can change the folder CMCP is in, then try again."))
                }
            }
        case "update", "install-update":
            guard FileManager.default.isWritableFile(atPath: bundle.bundleURL.deletingLastPathComponent().path) else {
                reply(id, error: tr("无法更新：你没有修改 CMCP 所在文件夹的权限。请用管理员账户更新，或重新安装新版本。", "Cannot update: you do not have permission to change the folder CMCP is in. Update from an administrator account, or install the new version again.")); return
            }
            request(action == "install-update" ? "/api/update/prepared" : "/api/update/download", [:]) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success(let value):
                    guard let update = value["directory"] as? [String: Any], let version = update["version"] as? String else { self.reply(id, error: self.tr("更新准备失败。", "Could not prepare the update.")); return }
                    guard self.confirmUpdate(version) else { self.reply(id, ["prepared": true, "version": version]); return }
                    do { try self.applyUpdate(value); self.reply(id, true) } catch { self.reply(id, error: self.tr("更新准备失败。", "Could not prepare the update.")) }
                case .failure: self.reply(id, error: self.tr("更新下载或校验失败。", "Update download or verification failed."))
                }
            }
        default: reply(id, error: "Unsupported native action")
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let allowed = url.scheme == "http" && url.host == "127.0.0.1" && url.port == URL(string: origin)?.port
        decisionHandler(allowed ? .allow : .cancel)
    }
    func desktop() -> URL { FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0] }
    func hasShortcut() -> Bool {
        guard let files = try? FileManager.default.contentsOfDirectory(at: desktop(), includingPropertiesForKeys: nil) else { return false }
        return files.contains { file in
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath: file.path)) != nil else { return false }
            return Bundle(url: file.resolvingSymlinksInPath())?.bundleIdentifier == bundle.bundleIdentifier
        }
    }
    func createShortcut() throws {
        if hasShortcut() { return }
        let destination = desktop().appendingPathComponent("CMCP.app")
        if FileManager.default.fileExists(atPath: destination.path) || (try? FileManager.default.destinationOfSymbolicLink(atPath: destination.path)) != nil { throw NSError(domain: "CMCP", code: 3) }
        try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: bundle.bundleURL)
    }
    func warnIfNotInstalled() {
        let path = bundle.bundleURL.path, parent = bundle.bundleURL.deletingLastPathComponent().path
        guard path.contains("/AppTranslocation/") || (path.hasPrefix("/Volumes/") && !FileManager.default.isWritableFile(atPath: parent)) else { return }
        alert(tr("请把 CMCP 拖到“应用程序”文件夹，再从那里打开。直接从磁盘映像运行时无法更新，也无法开机自启。", "Drag CMCP to the Applications folder and open it from there. Running directly from the disk image, it cannot update or start at sign-in."))
    }
    func confirmUpdate(_ version: String) -> Bool {
        let prompt = NSAlert()
        prompt.messageText = tr("CMCP \(version) 已下载并通过校验", "CMCP \(version) has been downloaded and verified")
        prompt.informativeText = tr("现在安装并重启吗？安装时会短暂断开全部连接。选择“稍后安装”可继续使用当前版本。", "Install and restart now? Installation briefly disconnects all connections. Choose Install later to keep using the current version.")
        prompt.addButton(withTitle: tr("安装并重启", "Install and restart"))
        prompt.addButton(withTitle: tr("稍后安装", "Install later"))
        prompt.buttons[0].keyEquivalent = ""
        prompt.buttons[1].keyEquivalent = "\r"
        return prompt.runModal() == .alertFirstButtonReturn
    }
    func applyUpdate(_ response: [String: Any]) throws {
        guard let update = response["directory"] as? [String: Any] else { throw NSError(domain: "CMCP", code: 4) }
        var value = update; value["installRoot"] = bundle.bundleURL.path; value["managerPid"] = ProcessInfo.processInfo.processIdentifier
        value["state"] = stateDirectory.path; value["nonce"] = UUID().uuidString
        let requestFile = stateDirectory.appendingPathComponent("update-request-" + UUID().uuidString + ".json")
        let data = try JSONSerialization.data(withJSONObject: value); try data.write(to: requestFile, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: requestFile.path)
        let helper = Process(); helper.executableURL = resources.appendingPathComponent("runtime/node"); helper.arguments = [resources.appendingPathComponent("macos/apply-update.mjs").path, requestFile.path]
        helper.standardOutput = FileHandle.nullDevice; helper.standardError = FileHandle.nullDevice
        try helper.run()
        request("/api/restart", [:]) { [weak self] result in
            if case .success = result { self?.exitApproved = true; NSApp.terminate(nil) }
        }
    }
    func alert(_ text: String) { let alert = NSAlert(); alert.messageText = text; alert.runModal() }
    func fail(_ text: String) { if testing { finishTests(error: text) } else { if updateRequest == nil { alert(text) }; exitApproved = true; NSApp.terminate(nil) } }
    func runTests() {
        let runningBackend = process
        window.orderOut(nil)
        _ = applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
        guard window.isVisible && process === runningBackend && ready else { finishTests(error: "Reopening must restore the existing window and backend"); return }
        testResults.append("reopening restores the native window without replacing its backend process")
        guard item.isVisible, trayTargets.count == 2, trayRows.count == 2 else { finishTests(error: "Resident tray cloud list missing"); return }
        testResults.append("resident menu bar icon lists every cloud")
        guard let nativeMenu = trayMenu, let button = item.button, button.window != nil, nativeMenu.delegate === self, item.menu == nil, button.action == #selector(trayClick(_:)), button.target === self else { finishTests(error: "Status menu must open from the native menu bar button"); return }
        menuNeedsUpdate(nativeMenu)
        guard item.menu == nil, trayMenu === nativeMenu, !trayTracking else { finishTests(error: "Preparing the tray menu changed its native anchor"); return }
        testResults.append("tray menu prepares content while retaining its native status button anchor")
        let unrelated = NSMenu(); menuWillOpen(unrelated); menuDidClose(unrelated)
        guard item.menu == nil, trayMenu === nativeMenu, !trayTracking else { finishTests(error: "Another menu changed tray tracking"); return }
        testResults.append("unrelated menus cannot change native tray tracking or positioning")
        hideWindow(); trayClick(nil)
        guard window.isVisible, NSApp.activationPolicy() == .regular, item.menu == nil, !trayTracking else { finishTests(error: "A left click on the menu bar icon must open the main window"); return }
        testResults.append("a left click on the menu bar icon opens the main window without the menu")
        guard trayRows.values.allSatisfy({ $0.submenu?.items.map({ $0.title }) == [tr("连接设备", "Connect device"), tr("断开设备", "Disconnect device"), tr("重命名", "Rename"), "", tr("切换为 CloudCLI 登录", "Switch to CloudCLI sign-in")] && $0.submenu?.items[3].isSeparatorItem == true }) else { finishTests(error: "Tray submenu actions missing"); return }
        testResults.append("native cloud submenus expose connect disconnect rename and the sign-in switch")
        let savedTargets = trayTargets, firstID = trayTargets[0]["id"] as! String, firstRow = trayRows[trayTargets[0]["id"] as! String]
        trayTargets[0]["label"] = "Tray note"; trayTargets[0]["state"] = "connected"; trayTargets[0]["enabled"] = true; updateTrayMenu()
        guard trayRows[firstID] === firstRow, firstRow?.toolTip == "Tray note · " + tr("已连接", "Connected"), firstRow?.attributedTitle?.string == "Tray note\t" + tr("已连接", "Connected"), firstRow?.image != nil, firstRow?.submenu?.items[0].isEnabled == false, firstRow?.submenu?.items[1].isEnabled == true else { finishTests(error: "Tray status refresh replaced rows or lost the display name"); return }
        trayTargets = savedTargets; updateTrayMenu(); testResults.append("tray updates remarks and states without replacing native rows")
        guard trayMenu.appearance == nil, window.appearance == nil else { finishTests(error: "Default appearance must follow the system"); return }
        testResults.append("native tray and fresh main window follow system appearance")
        func shade(_ name: NSAppearance.Name) -> [Int] {
            var color = NSColor.clear
            NSAppearance(named: name)?.performAsCurrentDrawingAppearance { color = self.window.backgroundColor.usingColorSpace(.sRGB) ?? .clear }
            return [color.redComponent, color.greenComponent, color.blueComponent].map { Int(($0 * 255).rounded()) }
        }
        guard web.value(forKey: "drawsBackground") as? Bool == false, shade(.darkAqua) == [0x14, 0x17, 0x1b], shade(.aqua) == [255, 255, 255] else {
            finishTests(error: "The window behind the page must show the page colour, not WebKit's white: \(shade(.darkAqua)) \(shade(.aqua))"); return
        }
        testResults.append("unpainted moments show the page colour of the current theme instead of white")
        window.setContentSize(NSSize(width: 700, height: 580))
        let checks = ["document.querySelector('.card-head').click(); document.querySelector('.card').classList.contains('expanded')", "document.querySelector('.card-head').click(); !document.querySelector('.card').classList.contains('expanded')", "document.querySelectorAll('.card.selected').length === 1", "getComputedStyle(document.documentElement,'::-webkit-scrollbar').display === 'none'", "document.body.scrollWidth <= window.innerWidth", "document.querySelector('header h1').textContent === 'CMCP'", "document.querySelectorAll('.card').length === 2", "document.querySelectorAll('.state-label').length === 2", "window.cmcpTest.showSettings('dark','en'); document.documentElement.dataset.theme === 'dark'", "document.querySelector('header h2').textContent === 'General'", "window.cmcpTest.showEditor(); document.querySelectorAll('.settings-nav button').length === 3 && document.querySelectorAll('input[type=password]').length === 2 && !!document.querySelector('[data-focus-key=\"edit:cloudUrl\"]')", "document.querySelectorAll('header').length === 1"] + ["window.cmcpTest.showUpdate(); document.querySelector('.settings-side button').click(); !document.querySelector('.update-banner') && !document.querySelector('.update-ring').hidden && document.querySelector('.update-ring').getAttribute('aria-valuetext').includes('37%')", "window.cmcpTest.showUpdateFailed(); !document.querySelector('.update-ring').hidden && document.querySelector('.update-ring').classList.contains('failed')", "window.cmcpTest.showAbout(); document.querySelectorAll('button.uninstall').length === 1"]
        let trayChecks = ["window.cmcpTest.renameFirst() && document.activeElement === document.querySelector('input[type=text]')", "document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length"]
        let allChecks = checks + trayChecks
        func next(_ index: Int) {
            if index == allChecks.count {
                self.window.setContentSize(NSSize(width: 700, height: 580))
                self.saveSnapshot("mac-editor-dark.png") { self.runMotionChecks() }
                return
            }
            self.web.evaluateJavaScript(allChecks[index]) { result, error in
                guard error == nil, (result as? Bool) == true else { self.finishTests(error: "UI check failed: " + String(index)); return }
                self.testResults.append("native WebKit check " + String(index + 1)); next(index + 1)
            }
        }
        // Follow all three modes through the real backend and refreshed native menu.
        func switched(_ mode: String, then done: @escaping () -> Void) {
            guard let change = firstRow?.submenu?.items[4] else { finishTests(error: "Tray switch missing"); return }
            traySwitch(change); var waited = 0
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
                let target = self.trayTargets.first { $0["id"] as? String == firstID }
                let current = target?["loginMode"] as? String ?? "web"
                let expected = mode == "cloudcli" ? self.tr("切换为 SSH 登录", "Switch to SSH sign-in") : mode == "ssh" ? self.tr("切换为网页桌面登录", "Switch to web desktop sign-in") : self.tr("切换为 CloudCLI 登录", "Switch to CloudCLI sign-in")
                if current == mode && self.trayPending.isEmpty && !self.trayRefreshing && change.title == expected { timer.invalidate(); done(); return }
                waited += 1; if waited > 100 { timer.invalidate(); self.finishTests(error: "Tray switch did not change the application") }
            }
        }
        switched("cloudcli") { switched("ssh") { switched("web") {
            guard self.window.isVisible, self.item.menu == nil else { self.finishTests(error: "Tray switch changed the window or menu anchor"); return }
            self.testResults.append("tray switch follows WebDesktop CloudCLI Terminal and relabels itself"); next(0)
        } } }
    }
    func saveSnapshot(_ name: String, then done: @escaping () -> Void) {
        web.takeSnapshot(with: nil) { image, error in
            if let image = image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]), let folder = self.reportDirectory {
                try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try? png.write(to: folder.appendingPathComponent(name))
            }
            if error == nil { done() } else { self.finishTests(error: "Snapshot failed") }
        }
    }
    // A real login cannot happen in CI, so this covers recognising the event and hiding the window.
    func loginStartProblem() -> String? {
        func event(_ id: AEEventID) -> NSAppleEventDescriptor { NSAppleEventDescriptor(eventClass: 0x61657674 /* aevt */, eventID: id, targetDescriptor: nil, returnID: -1, transactionID: 0) }
        let login = event(0x6F617070 /* oapp */), plain = event(0x6F617070 /* oapp */), other = event(0x72617070 /* rapp */)
        for marked in [login, other] { marked.setParam(NSAppleEventDescriptor(enumCode: 0x6C676974 /* lgit */), forKeyword: 0x70726F70 /* prop */) }
        guard App.launchedAtLogin(login), !App.launchedAtLogin(plain), !App.launchedAtLogin(other), !App.launchedAtLogin(nil) else { return "Login event recognition is wrong" }
        guard !startup else { return "An ordinary launch was treated as a login start" }
        hideWindow()
        guard !window.isVisible, NSApp.activationPolicy() == .accessory else { return "Login start must leave only the menu bar icon" }
        show()
        guard window.isVisible, NSApp.activationPolicy() == .regular else { return "The main window must open from the menu bar" }
        return nil
    }
    // Reported apart from `passed`, which the workflow pins; a failure here still fails the run.
    // Each check inspects animations in the same turn as the click, so timing cannot flake it.
    // CI Macs have Reduce Motion on, so a second pass drops the style sheet's reduced-motion
    // rule: the first pass proves pages switch directly, the second that the animations run.
    // The second pass also uses the smallest window, so its layout checks cover that size.
    func runMotionChecks() {
        let shared = "const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches&&!window.cmcpMotionForced,app=document.querySelector('#app'),wait=ms=>new Promise(done=>setTimeout(done,ms));const until=async test=>{for(let i=0;i<150&&!test();i++)await wait(20);return test();};const turning=(node,name)=>{const running=node.getAnimations();return reduced?running.length===0:running.some(a=>a.animationName===name&&a.effect.getTiming().duration===180);};const fading=(node,property,ms)=>{const running=node.getAnimations();return reduced?running.length===0:running.some(a=>a.transitionProperty===property&&a.effect.getTiming().duration===ms);};const settle=async node=>{const slide=node.getAnimations().find(a=>a.transitionProperty==='grid-template-rows');if(slide){await Promise.race([slide.finished.catch(()=>{}),wait(1500)]);if(slide.playState==='running')slide.finish();}await wait(20);};const cardTop=index=>document.querySelectorAll('.card')[index].getBoundingClientRect().top;const rowsFit=()=>[...document.querySelectorAll('.set-row')].every(row=>{const box=row.getBoundingClientRect(),parts=[...row.children].map(part=>part.getBoundingClientRect());return box.height>=56&&parts.every((part,i)=>part.left>=box.left&&part.right<=box.right+.5&&part.top>=box.top&&part.bottom<=box.bottom+.5&&(i===0||part.left>=parts[i-1].right-.5||part.top>=parts[i-1].bottom-.5));})&&document.querySelector('.settings-column').getBoundingClientRect().width<=680&&document.body.scrollWidth<=window.innerWidth;const show=window.cmcpTest.showUpdateState;const menuBox=()=>document.querySelector('.select-box'),menuList=()=>document.querySelector('.select-list'),menuRows=()=>[...document.querySelectorAll('.select-option')],UP='m6 15 6-6 6 6',DOWN='m6 9 6 6 6-6',arrow=()=>menuBox().querySelector('svg path').getAttribute('d'),expandedIs=value=>menuBox().getAttribute('aria-expanded')===String(value),press=key=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});menuBox().dispatchEvent(event);return event;},shade=node=>{for(const a of node.getAnimations())a.finish();return getComputedStyle(node).backgroundColor;},hoverRow=row=>row.dispatchEvent(new PointerEvent('pointermove',{bubbles:true})),folding=()=>{const list=menuList();return reduced?!list||list.getAnimations().length===0:!!list&&['opacity','clip-path'].every(name=>list.getAnimations().some(a=>a.transitionProperty===name&&a.effect.getTiming().duration===130));},unfolded=async()=>{for(const a of menuList().getAnimations()){await Promise.race([a.finished.catch(()=>{}),wait(1500)]);if(a.playState==='running')a.finish();}await wait(20);},gone=()=>until(()=>!menuList()),rowsShow=()=>menuRows().every(row=>{const r=row.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===row;});"
        let steps: [(name: String, body: String, snapshot: String?)] = [
            ("leaving the editor turns back while the page under the pointer stays clickable", "document.querySelector('.form-footer button').click();const add=document.querySelector('header .primary'),box=add.getBoundingClientRect();return !!document.querySelector('header h1')&&turning(app,'turn-back')&&document.elementFromPoint(box.left+box.width/2,box.top+box.height/2).closest('button')===add;", nil),
            ("opening settings turns forward and the page is already there", "document.querySelector('header .gear').click();return !!document.querySelector('header h2')&&!!document.querySelector('.settings-side')&&turning(app,'turn-forward');", nil),
            ("switching to About moves only the content and keeps keyboard focus", "const side=document.querySelector('.settings-side'),header=document.querySelector('header'),nav=side.querySelector('.settings-nav'),old=document.querySelector('.settings-column'),title=header.querySelector('h2').textContent,about=nav.children[3];about.focus();about.click();const column=document.querySelector('.settings-column');return header===document.querySelector('header')&&side===document.querySelector('.settings-side')&&column!==old&&header.querySelector('h2').textContent!==title&&document.activeElement===about&&about.classList.contains('chosen')&&about.getAttribute('aria-pressed')==='true'&&column.querySelectorAll('button.uninstall').length===1&&turning(column,'turn-forward')&&header.getAnimations().length===0&&side.getAnimations().length===0;", nil),
            ("a click during that transition still switches back", "const nav=document.querySelector('.settings-nav'),general=nav.children[0];general.click();const column=document.querySelector('.settings-column');return general.classList.contains('chosen')&&!nav.children[2].classList.contains('chosen')&&column.querySelectorAll('.select-box').length===1&&column.querySelectorAll('input.switch').length===2&&turning(column,'turn-back');", nil),
            ("the connection page offers browsers with their own icons, the close switches and the terminal", "await wait(230);const nav=document.querySelector('.settings-nav'),connect=nav.children[1];connect.click();await wait(1500);const column=document.querySelector('.settings-column'),switches=column.querySelectorAll('input.switch');const checks={chosen:connect.classList.contains('chosen'),title:['连接','Connection'].includes(document.querySelector('header h2').textContent),fields:column.querySelectorAll('.select-box').length===3,switches:switches.length===3,greyed:!!switches[0]&&switches[0].disabled,terminal:!!switches[2]&&!switches[2].disabled,icon:!!column.querySelector('.select-box img.select-icon'),fit:rowsFit()};const failed=Object.keys(checks).filter(key=>!checks[key]);if(!failed.length)return true;column.querySelector('.select-box').click();await wait(300);return 'failed: '+failed.join(',')+' options='+document.querySelectorAll('.select-list .select-option').length+' images='+document.querySelectorAll('.select-list img').length+' names='+[...document.querySelectorAll('.select-list .select-option')].map(row=>row.textContent).join('/');", nil),
            ("General rows fit in English with a language menu, icon segments and switches, and hover fades in 110 ms", "await wait(230);window.cmcpTest.showSettings('dark','en');const group=document.querySelector('.settings-column .segments'),options=[...group.children],boxes=[...group.children].map(option=>option.getBoundingClientRect()),box=document.querySelector('input.switch'),look=getComputedStyle(box),thumb=getComputedStyle(box,'::before'),hover=getComputedStyle(options[0]);return rowsFit()&&options.length===3&&options.every(option=>option.querySelector('svg'))&&boxes.every((rect,i)=>i===0||rect.left>=boxes[i-1].right-.5)&&group.querySelectorAll('.chosen').length===1&&options[2].classList.contains('chosen')&&document.querySelector('.settings-column .select-box').textContent==='English'&&box.type==='checkbox'&&box.getAttribute('role')==='switch'&&look.width==='44px'&&look.height==='24px'&&thumb.width==='18px'&&[...document.querySelectorAll('.row-title')].some(title=>title.textContent==='Minimize to menu bar on close')&&(reduced?hover.transitionDuration==='0s':hover.transitionProperty.startsWith('background-color')&&hover.transitionDuration.startsWith('0.11s'));", "mac-general-en.png"),
            ("About rows fit in English", "window.cmcpTest.showAbout();await wait(60);const ok=rowsFit()&&document.querySelectorAll('.set-row').length===6&&getComputedStyle(document.querySelector('button.uninstall')).boxShadow!=='none';window.cmcpTest.showSettings('dark','en');return ok;", nil),
            ("choosing a theme marks it at once, fades in 110 ms and does not rebuild the group", "window.cmcpTest.showSettings('dark','en');const group=document.querySelector('.settings-column .segments'),light=group.children[1];void light.offsetWidth;light.click();const immediate=light.classList.contains('chosen')&&light.getAttribute('aria-pressed')==='true'&&group.querySelectorAll('.chosen').length===1&&fading(light,'background-color',110);const saved=await until(()=>document.documentElement.dataset.theme==='light');await wait(60);return immediate&&saved&&light.isConnected&&light.classList.contains('chosen');", nil),
            ("the language field is a focusable combobox with a down arrow and no native menu", "window.cmcpTest.showSettings('dark','en');const field=menuBox(),look=getComputedStyle(field);return !document.querySelector('select')&&field.textContent==='English'&&field.tabIndex===0&&field.getAttribute('role')==='combobox'&&field.getAttribute('aria-haspopup')==='listbox'&&expandedIs(false)&&field.getAttribute('aria-label')==='Language'&&!field.hasAttribute('aria-controls')&&look.borderTopLeftRadius==='8px'&&look.height==='36px'&&arrow()===DOWN&&!menuList();", nil),
            ("a click unfolds the list for 130 ms with the arrow up, the current row is pale blue edge to edge, and nothing clips it", "const field=menuBox();field.click();const list=menuList(),started=!!list&&list.parentNode===document.body&&list.getAttribute('role')==='listbox'&&list.getAttribute('aria-label')==='Language'&&expandedIs(true)&&field.getAttribute('aria-controls')===list.id&&arrow()===UP&&folding()&&document.activeElement===field;await unfolded();const rows=menuRows(),area=list.getBoundingClientRect(),fits=area.top>=0&&area.bottom<=innerHeight&&area.left>=0&&area.right<=innerWidth&&area.top>=field.getBoundingClientRect().bottom,full=rows.length===2&&rows.every(row=>{const r=row.getBoundingClientRect();return Math.abs(r.width-list.clientWidth)<.5&&r.height===34&&row.getAttribute('role')==='option'&&!row.querySelector('svg,input');})&&rowsShow(),chosen=rows[1].classList.contains('chosen')&&rows[1].getAttribute('aria-selected')==='true'&&rows[0].getAttribute('aria-selected')==='false'&&field.getAttribute('aria-activedescendant')===rows[1].id&&shade(rows[1])==='rgb(41, 59, 85)'&&shade(rows[0])==='rgba(0, 0, 0, 0)',look=getComputedStyle(list);return started&&fits&&full&&chosen&&look.borderTopLeftRadius==='8px'&&look.opacity==='1';", "mac-dropdown-open.png"),
            ("hovering highlights one row at a time and leaving clears it", "const rows=menuRows();hoverRow(rows[1]);const hot=rows[1].classList.contains('active')&&shade(rows[1])==='rgb(46, 71, 107)';hoverRow(rows[0]);const moved=rows[0].classList.contains('active')&&!rows[1].classList.contains('active')&&shade(rows[0])==='rgb(42, 47, 55)'&&shade(rows[1])==='rgb(41, 59, 85)';menuList().dispatchEvent(new PointerEvent('pointerleave'));const clear=rows.every(row=>!row.classList.contains('active'));hoverRow(rows[0]);shade(rows[0]);return hot&&moved&&clear;", "mac-dropdown-hover.png"),
            ("a second click folds it with the arrow down and the list then leaves", "const field=menuBox(),list=menuList();field.click();const closing=expandedIs(false)&&arrow()===DOWN&&folding();const left=await gone();return closing&&left&&!list.isConnected&&!field.hasAttribute('aria-controls')&&!field.hasAttribute('aria-activedescendant')&&document.activeElement===field;", nil),
            ("a click during the animation reverses it from where it is", "const field=menuBox();field.click();const list=menuList();for(const a of list.getAnimations())a.currentTime=65;const before=Number(getComputedStyle(list).opacity);field.click();const closing=expandedIs(false)&&arrow()===DOWN&&(reduced?!menuList():before>0&&list.isConnected&&Math.abs(Number(getComputedStyle(list).opacity)-before)<.1&&list.getAnimations().length===2);await wait(30);field.click();const opening=expandedIs(true)&&arrow()===UP&&!!menuList()&&(reduced||(menuList()===list&&list.classList.contains('open')));await wait(200);const kept=!!menuList()&&expandedIs(true);await unfolded();const shown=getComputedStyle(menuList()).opacity==='1';press('Escape');await gone();return closing&&opening&&kept&&shown;", nil),
            ("Esc, a click outside, Tab, scrolling and a rebuild each close it, and a press on the field alone does not", "const field=menuBox();field.focus();field.click();const esc=press('Escape').defaultPrevented&&expandedIs(false)&&document.activeElement===field;await gone();field.click();document.querySelector('.settings-section h3').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));const outside=expandedIs(false);await gone();field.click();const tab=!press('Tab').defaultPrevented&&expandedIs(false);await gone();field.click();field.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));const own=expandedIs(true);document.dispatchEvent(new Event('scroll'));const scroll=expandedIs(false);await gone();field.click();window.cmcpTest.showSettings('dark','en');const rebuilt=await gone();return esc&&outside&&tab&&own&&scroll&&rebuilt&&expandedIs(false);", nil),
            ("Enter, Space and both arrows open it; the arrows move and stop at the ends; Enter and Space pick; focus stays on the rebuilt field", "for(const key of ['Enter',' ','ArrowDown','ArrowUp']){if(!press(key).defaultPrevented||!expandedIs(true)||!menuList())return false;press('Escape');await gone();}const field=menuBox();field.focus();press('ArrowDown');const rows=menuRows(),current=()=>field.getAttribute('aria-activedescendant'),lit=i=>rows[i].classList.contains('active')&&current()===rows[i].id;const start=current()===rows[1].id&&rows.every(row=>!row.classList.contains('active'));press('ArrowDown');const bottom=lit(1);press('ArrowUp');const up=lit(0)&&rows[0].getAttribute('aria-selected')==='false';press('ArrowUp');const top=lit(0);press('End');const end=lit(1);press('Home');const home=lit(0);press('Enter');const picked=expandedIs(false)&&field.textContent==='简体中文';const zh=await until(()=>document.querySelector('header h2').textContent==='通用');const moved=document.activeElement===menuBox()&&menuBox()!==field&&menuBox().textContent==='简体中文';await gone();press('ArrowDown');press('ArrowDown');press(' ');const en=await until(()=>document.querySelector('header h2').textContent==='General');await gone();return start&&bottom&&up&&top&&end&&home&&picked&&zh&&moved&&en&&document.activeElement===menuBox()&&menuBox().textContent==='English';", nil),
            ("picking the current language only closes the list, and a failed save puts the old one back", "const field=menuBox();field.click();press('Enter');const same=expandedIs(false)&&menuBox()===field&&field.textContent==='English';await gone();const real=window.fetch;window.fetch=()=>Promise.reject(Error('offline'));field.click();menuRows()[0].click();const eager=field.textContent==='简体中文';const back=await until(()=>field.textContent==='English');window.fetch=real;await gone();return same&&eager&&back&&field.isConnected&&document.querySelector('#notice').classList.contains('visible');", nil),
            ("with no room below it opens above the field, still whole", "const field=menuBox(),column=document.querySelector('.settings-column');column.style.paddingTop=Math.max(0,innerHeight-field.getBoundingClientRect().bottom-10)+'px';field.click();const list=menuList();await unfolded();const area=list.getBoundingClientRect(),ok=list.classList.contains('above')&&area.bottom<=field.getBoundingClientRect().top&&area.top>=0&&rowsShow();return ok;", "mac-dropdown-above.png"),
            ("a list stopped halfway is partly clipped", "press('Escape');await gone();document.querySelector('.settings-column').style.paddingTop='';const field=menuBox();field.click();const list=menuList();for(const a of list.getAnimations()){a.pause();a.currentTime=65;}await wait(60);return reduced||getComputedStyle(list).clipPath!=='inset(0% 0% 0% 0%)'&&Number(getComputedStyle(list).opacity)<1;", "mac-dropdown-mid.png"),
            ("it finishes from there and closes", "for(const a of menuList().getAnimations())a.finish();press('Escape');return await gone();", nil),
            ("clicking a language switches, folds and rebuilds the page with keyboard focus on the field", "window.cmcpTest.showSettings('light','en');const field=menuBox();field.focus();field.click();await unfolded();menuRows()[0].click();const folding_=expandedIs(false)&&field.textContent==='简体中文';const saved=await until(()=>document.querySelector('header h2').textContent==='通用');const now=document.activeElement;await gone();await wait(250);return folding_&&saved&&now!==field&&now===menuBox()&&now.dataset.focusKey===field.dataset.focusKey&&now.textContent==='简体中文'&&[...document.querySelectorAll('.row-title')].some(title=>title.textContent==='关闭时最小化到菜单栏')&&rowsFit();", "mac-general.png"),
            ("the current row is pale blue in the light theme too", "menuBox().click();await unfolded();return shade(menuRows()[0])==='rgb(207, 228, 255)'&&shade(menuRows()[1])==='rgba(0, 0, 0, 0)';", "mac-dropdown-light.png"),
            ("it closes again before the next check", "press('Escape');return await gone();", nil),
            ("both switches change at once and stay in place while saving", "for(const box of document.querySelectorAll('input.switch')){const before=box.checked;box.click();const immediate=box.checked!==before;await wait(150);const kept=box.isConnected&&box.checked!==before;box.click();await wait(150);if(!immediate||!kept||box.checked!==before)return false;}return true;", nil),
            ("About keeps checking available and waits for approval after verification", "const nav=document.querySelector('.settings-nav');nav.children[3].click();const run=document.querySelector('.settings-column .set-row button'),check=document.querySelectorAll('.settings-column .set-row button')[1],title=document.querySelector('.row-title'),detail=document.querySelector('.row-detail'),aboutDot=nav.querySelector('.dot');show({state:'latest',version:null});const latest=run.textContent==='下载更新'&&run.disabled&&check.textContent==='检查更新'&&!check.disabled&&title.textContent.startsWith('CMCP ')&&detail.textContent.includes('已是最新版')&&aboutDot.hidden;show({state:'available',version:'9.9.9'});const found=run.textContent==='下载更新'&&!run.disabled&&!check.disabled&&title.textContent==='发现新版本 9.9.9'&&detail.textContent.includes('当前版本')&&!aboutDot.hidden;show({state:'updating',version:'9.9.9',phase:'download',received:37,total:100});const running=run.disabled&&check.disabled&&document.querySelector('.update-slot progress')?.value===37&&!aboutDot.hidden;show({state:'failed',version:'9.9.9',code:'network'});const failed=!run.disabled&&run.textContent==='下载更新'&&!check.disabled&&!!document.querySelector('.update-slot .update-banner.failed')&&!document.querySelector('.update-banner progress');show({state:'ready',version:'9.9.9',phase:'ready',received:1,total:1});const prepared=run.textContent==='安装更新'&&!run.disabled&&!check.disabled&&detail.textContent.includes('稍后安装');show({state:'available',version:'9.9.9'});await wait(250);return latest&&found&&running&&failed&&prepared&&!!document.querySelector('.update-slot .update-banner[hidden]')&&rowsFit();", "mac-about-update.png"),
            ("General shows no update progress but keeps the dot on About", "const nav=document.querySelector('.settings-nav');show({state:'updating',version:'9.9.9',phase:'download',received:37,total:100});nav.children[0].click();return !document.querySelector('.update-banner')&&!nav.querySelector('.dot').hidden;", nil),
            ("going back turns back to a toolbar with only the gear and the add button, and the gear shows the dot", "show({state:'available',version:'9.9.9'});document.querySelector('.settings-side button').click();const gear=document.querySelector('header .gear'),started=!!document.querySelector('header h1')&&turning(app,'turn-back');const toolbar=document.querySelectorAll('header button').length===2&&!!document.querySelector('header .primary')&&!document.querySelector('.settings-side');const lit=!gear.querySelector('.dot').hidden&&gear.getAttribute('aria-label').includes('有可用更新');show({state:'latest',version:null});const dark=gear.querySelector('.dot').hidden;await wait(250);show({state:'available',version:'9.9.9'});return started&&toolbar&&lit&&dark;", "mac-home-update.png"),
            ("expanding a card slides for 170 ms and the card below moves down", "const card=document.querySelector('.card'),head=card.querySelector('.card-head'),accordion=card.querySelector('.accordion'),before=cardTop(1);void head.offsetHeight;head.click();const started=card.classList.contains('expanded')&&head.getAttribute('aria-expanded')==='true'&&fading(accordion,'grid-template-rows',170);await settle(accordion);await wait(250);return started&&cardTop(1)>before;", "mac-home-expanded.png"),
            ("collapsing a card slides for 170 ms and the card below moves back", "const card=document.querySelector('.card'),head=card.querySelector('.card-head'),accordion=card.querySelector('.accordion'),before=cardTop(1);void head.offsetHeight;head.click();const started=!card.classList.contains('expanded')&&head.getAttribute('aria-expanded')==='false'&&fading(accordion,'grid-template-rows',170);await settle(accordion);return started&&cardTop(1)<before;", nil),
            ("a collapsed card's buttons cannot take focus and an expanded card's can", "const card=document.querySelector('.card'),head=card.querySelector('.card-head'),inner=card.querySelector('.accordion>div'),action=inner.querySelector('button');const hidden=await until(()=>getComputedStyle(inner).visibility==='hidden');action.focus();const closed=document.activeElement!==action;head.click();action.focus();const open=document.activeElement===action;action.blur();head.click();const hiddenAgain=await until(()=>getComputedStyle(inner).visibility==='hidden');return hidden&&closed&&open&&hiddenAgain;", nil),
            ("the list updates while a card holds focus, keeps that focus and is not rebuilt without a change", "await wait(200);const first=document.querySelector('.card'),head=first.querySelector('.card-head');head.focus();window.cmcpTest.resendState();const same=document.querySelector('.card')===first&&document.activeElement===head;const connect=first.querySelector('.actions .connect');connect.focus();const key=connect.dataset.focusKey;window.cmcpTest.relabelFirst('Renamed');const now=document.activeElement,card=document.querySelector('.card');return same&&card!==first&&card.querySelector('strong').textContent==='Renamed'&&now!==connect&&now.dataset.focusKey===key&&card.contains(now);", nil),
            ("a change waits for a card's slide and is applied on the next refresh", "document.activeElement.blur();const first=document.querySelector('.card');first.querySelector('.card-head').click();window.cmcpTest.relabelFirst('Held back');const held=document.querySelector('.card')===first&&first.querySelector('strong').textContent!=='Held back';await wait(200);window.cmcpTest.relabelFirst('Held back');const card=document.querySelector('.card'),applied=card.querySelector('strong').textContent==='Held back'&&card.classList.contains('expanded');card.querySelector('.card-head').click();await wait(200);await window.cmcpTest.refreshNow();const label=document.querySelector('.card strong').textContent;return held&&applied&&label!=='Held back'&&label!=='Renamed';", nil),
            ("the editor has three categories and the SSH page follows the chosen method", "window.cmcpTest.showEditor();const tabs=[...document.querySelectorAll('.settings-nav button')];tabs[2].click();await wait(230);const rows=[...document.querySelectorAll('.edit-row')],off=document.querySelector('.edit-row.off');const ok=tabs.length===3&&tabs[2].classList.contains('chosen')&&rows.length===15&&!!off&&off.querySelector('input').disabled&&rows.every(row=>row.getBoundingClientRect().right<=window.innerWidth&&row.scrollWidth<=row.clientWidth+1)&&document.body.scrollWidth<=window.innerWidth;return ok||JSON.stringify({tabs:tabs.length,rows:rows.map(row=>[row.scrollWidth,row.clientWidth]),body:document.body.scrollWidth,width:window.innerWidth});", "mac-editor-ssh.png"),
            ("the general page of the editor fits and keeps its footer", "const tabs=[...document.querySelectorAll('.settings-nav button')];tabs[0].click();await wait(230);const rows=[...document.querySelectorAll('.edit-row')];const ok=rows.length===4&&rows.every(row=>row.scrollWidth<=row.clientWidth+1)&&!!document.querySelector('.form-footer button.primary');return ok||JSON.stringify(rows.map(row=>[row.scrollWidth,row.clientWidth]));", "mac-editor-general.png"),
            ("a card on SSH offers the terminal and shows its address", "document.querySelector('.form-footer button').click();window.cmcpTest.sshFirst();const card=document.querySelector('.card');card.querySelector('.card-head').focus();const connect=card.querySelector('.connect');return card.querySelector('.url').textContent==='192.0.2.9'&&card.querySelector('.card-app-choice').textContent.trim()==='Terminal'&&card.querySelector('.card-route-choice .select-box').getAttribute('aria-disabled')!=='true'&&card.querySelector('.card-route-choice').textContent.trim()==='SSH'&&!connect.classList.contains('primary')&&card.querySelector('.state-label').textContent.startsWith('Terminal · ')&&document.body.scrollWidth<=window.innerWidth||JSON.stringify({url:card.querySelector('.url').textContent,body:document.body.scrollWidth,width:window.innerWidth});", "mac-home-ssh.png"),
            ("the list returns to the saved devices", "await window.cmcpTest.refreshNow();return document.querySelector('.url').textContent!=='192.0.2.9';", nil)
        ]
        let forceMotion = "const sheet=document.styleSheets[0],rule=[...sheet.cssRules].findIndex(item=>item.cssText.includes('prefers-reduced-motion'));if(rule<0)return false;sheet.deleteRule(rule);window.cmcpMotionForced=true;window.cmcpTest.showEditor();return getComputedStyle(document.querySelector('.form-footer button')).transitionDuration.startsWith('0.11s');"
        func next(_ index: Int, _ pass: String, then done: @escaping () -> Void) {
            guard index < steps.count else { done(); return }
            let step = steps[index]
            web.callAsyncJavaScript(shared + step.body, arguments: [:], in: nil, in: .page) { result in
                guard case .success(let value) = result, (value as? Bool) == true else { self.finishTests(error: "Motion check failed: " + pass + ": " + step.name + " (" + String(describing: result) + ")"); return }
                self.motionResults.append(pass + ": " + step.name)
                if let snapshot = step.snapshot { self.saveSnapshot((pass == "animated" && self.reducedMotion ? "narrow-" : "") + snapshot) { next(index + 1, pass, then: done) } } else { next(index + 1, pass, then: done) }
            }
        }
        // Real AppKit events go through WebKit's hit testing, focus and key handling, which the
        // script events above skip. They are still sent by a program, not by a hand on a mouse.
        let actions: [(name: String, kind: String, argument: String, check: String)] = [
            ("prepare", "none", "", "window.cmcpMoves=0;document.addEventListener('pointermove',()=>window.cmcpMoves++,true);window.cmcpTest.showSettings('dark','en');document.querySelectorAll('.settings-nav button')[1].focus();return true;"),
            ("Tab reaches the field", "key", "tab", "return document.activeElement===menuBox()&&expandedIs(false);"),
            ("the down arrow opens it", "key", "down", "return expandedIs(true)&&!!menuList()&&arrow()===UP;"),
            ("Esc closes it and keeps focus", "key", "escape", "return expandedIs(false)&&!menuList()&&arrow()===DOWN&&document.activeElement===menuBox();"),
            ("a click opens it and focuses the field", "click", "menuBox()", "return expandedIs(true)&&!!menuList()&&document.activeElement===menuBox();"),
            ("a mouse move is sent and only counted", "move", "menuRows()[0]", "return true;"),
            ("a second click closes it and does not reopen it", "click", "menuBox()", "return expandedIs(false)&&!menuList();"),
            ("a click opens it again", "click", "menuBox()", "return expandedIs(true)&&!!menuList();"),
            ("a click outside closes it", "click", "document.querySelector('.settings-section h3')", "return expandedIs(false)&&!menuList();"),
            ("a click opens it once more", "click", "menuBox()", "return expandedIs(true)&&!!menuList();"),
            ("a click on a language switches and leaves focus on the field", "click", "menuRows()[0]", "const saved=await until(()=>document.querySelector('header h2').textContent==='通用');await gone();return saved&&document.activeElement===menuBox()&&menuBox().textContent==='简体中文'&&expandedIs(false);")
        ]
        let keys: [String: (code: UInt16, text: String)] = ["tab": (48, "\t"), "down": (125, "\u{F701}"), "escape": (53, "\u{1B}")]
        func sendMouse(_ type: NSEvent.EventType, _ point: NSPoint) {
            let moving = type == .mouseMoved
            if let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: point.x, y: web.bounds.height - point.y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: moving ? 0 : 1, pressure: moving ? 0 : 1) { if moving { web.mouseMoved(with: event) } else { window.sendEvent(event) } }
        }
        func input(_ index: Int) {
            guard index < actions.count else {
                // Program-sent mouse moves have not reached the page in CI, even on the key window, so
                // hover rests on the script check above and the report only records what this run saw.
                let active = NSApp.keyWindow === window
                web.evaluateJavaScript("window.cmcpMoves") { value, _ in
                    self.motionResults.append("real input: key window: " + String(active) + ", pointer moves seen: " + String(describing: value ?? "unknown"))
                    self.finishTests(error: nil)
                }
                return
            }
            let action = actions[index]
            func verify() {
                let pause: TimeInterval = action.kind == "none" ? 0 : 0.35
                DispatchQueue.main.asyncAfter(deadline: .now() + pause) {
                    self.web.callAsyncJavaScript(shared + action.check, arguments: [:], in: nil, in: .page) { result in
                        guard case .success(let value) = result, (value as? Bool) == true else { self.finishTests(error: "Real input check failed: " + action.name + " (" + String(describing: result) + ")"); return }
                        self.motionResults.append("real input: " + action.name)
                        input(index + 1)
                    }
                }
            }
            switch action.kind {
            case "none":
                verify()
            case "key":
                let key = keys[action.argument]!
                if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: key.text, charactersIgnoringModifiers: key.text, isARepeat: false, keyCode: key.code) { window.sendEvent(event) }
                verify()
            default:
                web.callAsyncJavaScript(shared + "const area=(" + action.argument + ").getBoundingClientRect();return [area.left+area.width/2,area.top+area.height/2];", arguments: [:], in: nil, in: .page) { result in
                    guard case .success(let value) = result, let spot = value as? [NSNumber], spot.count == 2 else { self.finishTests(error: "Real input target failed: " + action.name + " (" + String(describing: result) + ")"); return }
                    let point = NSPoint(x: spot[0].doubleValue, y: spot[1].doubleValue)
                    if action.kind == "move" { sendMouse(.mouseMoved, point) } else { sendMouse(.leftMouseDown, point); sendMouse(.leftMouseUp, point) }
                    verify()
                }
            }
        }
        if let problem = loginStartProblem() { finishTests(error: problem); return }
        motionResults.append("login start: the event is recognised, the window hides and it opens again")
        web.evaluateJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches") { value, _ in
            self.reducedMotion = value as? Bool ?? false
            next(0, self.reducedMotion ? "reduced motion" : "animated") {
                self.window.setContentSize(NSSize(width: 660, height: 472))
                self.web.callAsyncJavaScript(forceMotion, arguments: [:], in: nil, in: .page) { result in
                    guard case .success(let value) = result, (value as? Bool) == true else { self.finishTests(error: "Could not turn off the reduced-motion rule (" + String(describing: result) + ")"); return }
                    next(0, "animated") { self.window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); self.window.makeFirstResponder(self.web); input(0) }
                }
            }
        }
    }
    func finishTests(error: String?) {
        if let folder = reportDirectory {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let result: [String: Any] = ["passed": testResults.count, "failed": error == nil ? 0 : 1, "error": error ?? "", "checks": testResults, "motion_checks": motionResults, "reduced_motion": reducedMotion, "not_executed": ["real cloud connection", "user TCC permissions", "real login item approval", "how the animations look on a real Mac display", "a real start from the login item", "the language dropdown with a real mouse and keyboard on a real Mac"]]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted) { try? data.write(to: folder.appendingPathComponent("native-ui.json")) }
            try? testStderr.write(to: folder.appendingPathComponent("backend.stderr.txt"))
        }
        exitApproved = true; process?.terminate(); NSApp.terminate(nil)
    }
}

func desktopAction() {
    do {
        let raw = FileHandle.standardInput.readDataToEndOfFile()
        guard raw.count <= 65536, let input = try JSONSerialization.jsonObject(with: raw) as? [String: Any], let action = input["action"] as? String,
              AXIsProcessTrusted() else { throw NSError(domain: "CMCP", code: 10) }
        let point = CGPoint(x: (input["x"] as? Double) ?? 0, y: (input["y"] as? Double) ?? 0)
        let source = CGEventSource(stateID: .hidSystemState)
        if action == "move_mouse" { CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap) }
        else if action == "click" || action == "double_click" {
            let right = input["button"] as? String == "right", middle = input["button"] as? String == "middle"
            let button: CGMouseButton = right ? .right : middle ? .center : .left
            let down: CGEventType = right ? .rightMouseDown : middle ? .otherMouseDown : .leftMouseDown
            let up: CGEventType = right ? .rightMouseUp : middle ? .otherMouseUp : .leftMouseUp
            for count in 1...(action == "double_click" ? 2 : 1) { for type in [down, up] { let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button); event?.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event?.post(tap: .cghidEventTap) } }
        } else if action == "type_text", let text = input["text"] as? String {
            let values = Array(text.utf16); guard values.count <= 10000 else { throw NSError(domain: "CMCP", code: 11) }; if values.isEmpty { print("{\"ok\":true}"); return }
            for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down); values.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: values.count, unicodeString: $0.baseAddress!) }; event?.post(tap: .cghidEventTap) }
        } else {
            let table: [String: CGKeyCode] = ["return":36,"enter":36,"tab":48,"space":49,"backspace":51,"escape":53,"left":123,"right":124,"down":125,"up":126,"a":0,"c":8,"v":9,"x":7,"z":6,"s":1,"w":13,"q":12,"f":3,"l":37,"r":15,"t":17]
            let keys = input["keys"] as? [String] ?? []; var flags: CGEventFlags = []; var codes: [CGKeyCode] = []
            guard !keys.isEmpty, keys.count <= 8 else { throw NSError(domain: "CMCP", code: 12) }
            for key in keys { switch key.lowercased() { case "command", "cmd": flags.insert(.maskCommand); case "control", "ctrl": flags.insert(.maskControl); case "option", "alt": flags.insert(.maskAlternate); case "shift": flags.insert(.maskShift); default: guard let code = table[key.lowercased()] else { throw NSError(domain: "CMCP", code: 13) }; codes.append(code) } }
            for code in codes { for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down); event?.flags = flags; event?.post(tap: .cghidEventTap) } }
        }
        print("{\"ok\":true}")
    } catch { fputs("Desktop action failed. Check Accessibility permission and arguments.\n", stderr); exit(1) }
}

if CommandLine.arguments.contains("--desktop-action") { desktopAction() }
else {
    let application = NSApplication.shared
    let delegate = App(arguments: CommandLine.arguments)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
}
