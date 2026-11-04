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
    func applicationDidFinishLaunching(_ notification: Notification) {
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
        NSApp.setActivationPolicy(.regular)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "cmcp")
        if testing { configuration.userContentController.addUserScript(WKUserScript(source: "window.CMCP_TEST=true", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "CMCP"; window.minSize = NSSize(width: 660, height: 500); window.center(); window.delegate = self
        window.contentView = web; window.isReleasedWhenClosed = false
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(restoreExistingWindow(_:)), name: NSNotification.Name("com.cmcp.manager.restore"), object: bundle.bundleURL.standardizedFileURL.path)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "CMCP")
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
        if item.menu == nil {
            let menu = NSMenu(); menu.delegate = self; menu.autoenablesItems = false; menu.appearance = nil
            menu.addItem(withTitle: "", action: #selector(show), keyEquivalent: "").target = self
            menu.addItem(.separator()); menu.addItem(.separator())
            menu.addItem(withTitle: "", action: #selector(quit), keyEquivalent: "").target = self
            item.menu = menu
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
        guard let menu = item?.menu else { return }
        menu.items.first?.title = tr("打开主界面", "Open main window"); menu.items.last?.title = tr("退出程序", "Exit application")
        let ids = trayTargets.compactMap { $0["id"] as? String }
        if ids != trayOrder && !trayTracking {
            while menu.items.count > 4 { menu.removeItem(at: 2) }
            trayRows = trayRows.filter { ids.contains($0.key) }
            for (index, id) in ids.enumerated() {
                if trayRows[id] == nil {
                    let row = NSMenuItem(title: "", action: nil, keyEquivalent: ""), sub = NSMenu()
                    sub.autoenablesItems = false; sub.appearance = nil
                    for selector in [#selector(trayConnect(_:)), #selector(trayDisconnect(_:)), #selector(trayRename(_:))] {
                        let command = NSMenuItem(title: "", action: selector, keyEquivalent: ""); command.target = self; command.representedObject = id; sub.addItem(command)
                    }
                    row.submenu = sub; trayRows[id] = row
                }
                menu.insertItem(trayRows[id]!, at: index + 2)
            }
            trayOrder = ids
        }
        if ids.isEmpty && !trayTracking && menu.items.count == 4 { let empty = NSMenuItem(title: "", action: nil, keyEquivalent: ""); empty.identifier = NSUserInterfaceItemIdentifier("empty"); empty.isEnabled = false; menu.insertItem(empty, at: 2) }
        if let empty = menu.items.first(where: { $0.identifier?.rawValue == "empty" }) { empty.title = tr("暂无云电脑", "No cloud PCs") }
        for target in trayTargets {
            guard let id = target["id"] as? String, let row = trayRows[id], let sub = row.submenu else { continue }
            let state = target["state"] as? String ?? "stopped", enabled = target["enabled"] as? Bool == true
            row.title = (target["label"] as? String ?? "CMCP") + " · " + trayState(state); row.toolTip = row.title
            let active = ["connected", "connecting", "configuring", "waiting-login", "recovering", "unstable"].contains(state)
            let blocked = !ready || exitPending || trayUpdating || trayPending.contains(id)
            sub.items[0].title = tr("连接云电脑", "Connect cloud PC"); sub.items[0].isEnabled = !blocked && !active
            sub.items[1].title = tr("断开云电脑", "Disconnect cloud PC"); sub.items[1].isEnabled = !blocked && enabled
            sub.items[2].title = tr("重命名", "Rename"); sub.items[2].isEnabled = !blocked
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
    func menuNeedsUpdate(_ menu: NSMenu) { if menu === item.menu && !trayTracking { updateTrayMenu() } }
    func menuWillOpen(_ menu: NSMenu) { if menu === item.menu { trayTracking = true; refreshTray() } }
    func menuDidClose(_ menu: NSMenu) { if menu === item.menu { trayTracking = false; updateTrayMenu() } }
    func trayAction(_ sender: NSMenuItem, route: String) {
        guard let id = sender.representedObject as? String, let row = trayRows[id], let sub = row.submenu else { return }
        let index = route == "start" ? 0 : 1; guard sub.items[index].isEnabled else { return }
        trayPending.insert(id); updateTrayMenu()
        request("/api/targets/" + route, ["id": id]) { [weak self] result in
            guard let self = self else { return }; self.trayPending.remove(id)
            if case .failure = result { self.show(); self.web.evaluateJavaScript("window.cmcpTrayError()", completionHandler: nil) }
            self.refreshTray()
        }
    }
    @objc func trayConnect(_ sender: NSMenuItem) { trayAction(sender, route: "start") }
    @objc func trayDisconnect(_ sender: NSMenuItem) { trayAction(sender, route: "stop") }
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
            if startup { window.orderOut(nil); NSApp.setActivationPolicy(.accessory) }
        }
    }
    @objc func show() { NSApp.setActivationPolicy(.regular); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func restoreExistingWindow(_ notification: Notification) { DispatchQueue.main.async { self.show() } }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return false }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeAction == "tray" { window.orderOut(nil); NSApp.setActivationPolicy(.accessory) } else { quit() }
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
        case "copy":
            guard let text = value["text"] as? String, text.count < 8192 else { reply(id, error: "Invalid text"); return }
            NSPasteboard.general.clearContents(); reply(id, NSPasteboard.general.setString(text, forType: .string))
        case "confirm":
            let alert = NSAlert(); alert.messageText = String((value["text"] as? String ?? "").prefix(200)); alert.addButton(withTitle: tr("确定", "Confirm")); alert.addButton(withTitle: tr("取消", "Cancel"))
            reply(id, alert.runModal() == .alertFirstButtonReturn)
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
        case "update":
            guard FileManager.default.isWritableFile(atPath: bundle.bundleURL.deletingLastPathComponent().path) else {
                reply(id, error: tr("无法更新：你没有修改 CMCP 所在文件夹的权限。请用管理员账户更新，或重新安装新版本。", "Cannot update: you do not have permission to change the folder CMCP is in. Update from an administrator account, or install the new version again.")); return
            }
            request("/api/update/download", [:]) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success(let value):
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
        guard let nativeMenu = item.menu, let button = item.button, button.window != nil, nativeMenu.delegate === self else { finishTests(error: "Status menu must remain attached to the native menu bar button"); return }
        menuNeedsUpdate(nativeMenu)
        guard item.menu === nativeMenu, !trayTracking else { finishTests(error: "Preparing the tray menu changed its native anchor"); return }
        testResults.append("tray menu prepares content while retaining its native status button anchor")
        let unrelated = NSMenu(); menuWillOpen(unrelated); menuDidClose(unrelated)
        guard item.menu === nativeMenu, !trayTracking else { finishTests(error: "Another menu changed tray tracking"); return }
        testResults.append("unrelated menus cannot change native tray tracking or positioning")
        guard trayRows.values.allSatisfy({ $0.submenu?.items.map({ $0.title }) == [tr("连接云电脑", "Connect cloud PC"), tr("断开云电脑", "Disconnect cloud PC"), tr("重命名", "Rename")] }) else { finishTests(error: "Tray submenu actions missing"); return }
        testResults.append("native cloud submenus expose connect disconnect and rename")
        let savedTargets = trayTargets, firstID = trayTargets[0]["id"] as! String, firstRow = trayRows[trayTargets[0]["id"] as! String]
        trayTargets[0]["label"] = "Tray note"; trayTargets[0]["state"] = "connected"; trayTargets[0]["enabled"] = true; updateTrayMenu()
        guard trayRows[firstID] === firstRow, firstRow?.title == "Tray note · " + tr("已连接", "Connected"), firstRow?.submenu?.items[0].isEnabled == false, firstRow?.submenu?.items[1].isEnabled == true else { finishTests(error: "Tray status refresh replaced rows or lost the display name"); return }
        trayTargets = savedTargets; updateTrayMenu(); testResults.append("tray updates remarks and states without replacing native rows")
        guard item.menu?.appearance == nil, window.appearance == nil else { finishTests(error: "Default appearance must follow the system"); return }
        testResults.append("native tray and fresh main window follow system appearance")
        window.setContentSize(NSSize(width: 700, height: 580))
        let checks = ["document.querySelector('.card-head').click(); document.querySelector('.card').classList.contains('expanded')", "document.querySelector('.card-head').click(); !document.querySelector('.card').classList.contains('expanded')", "document.querySelectorAll('.card.selected').length === 1", "getComputedStyle(document.documentElement,'::-webkit-scrollbar').display === 'none'", "document.body.scrollWidth <= window.innerWidth", "document.querySelector('header h1').textContent === 'CMCP'", "document.querySelectorAll('.card').length === 2", "document.querySelectorAll('.state-label').length === 2", "window.cmcpTest.showSettings('dark','en'); document.documentElement.dataset.theme === 'dark'", "document.querySelector('header h2').textContent === 'Settings'", "window.cmcpTest.showEditor(); document.querySelectorAll('input[type=password]').length === 1", "document.querySelectorAll('header').length === 1"] + ["window.cmcpTest.showUpdate(); document.querySelector('.update-banner progress').value === 37", "window.cmcpTest.showUpdateFailed(); !document.querySelector('.update-banner').hidden && document.querySelector('.update-banner').classList.contains('failed')", "window.cmcpTest.showAbout(); document.querySelectorAll('button.uninstall').length === 1"]
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
        next(0)
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
    // Reported apart from `passed`, which the workflow pins; a failure here still fails the run.
    // Each check inspects animations in the same turn as the click, so timing cannot flake it.
    // CI Macs have Reduce Motion on, so a second pass drops the style sheet's reduced-motion
    // rule: the first pass proves pages switch directly, the second that the animations run.
    func runMotionChecks() {
        let shared = "const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches&&!window.cmcpMotionForced,app=document.querySelector('#app'),wait=ms=>new Promise(done=>setTimeout(done,ms));const until=async test=>{for(let i=0;i<150&&!test();i++)await wait(20);return test();};const turning=(node,name)=>{const running=node.getAnimations();return reduced?running.length===0:running.some(a=>a.animationName===name&&a.effect.getTiming().duration===180);};const fading=(node,property,ms)=>{const running=node.getAnimations();return reduced?running.length===0:running.some(a=>a.transitionProperty===property&&a.effect.getTiming().duration===ms);};const settle=async node=>{const slide=node.getAnimations().find(a=>a.transitionProperty==='grid-template-rows');if(slide){await Promise.race([slide.finished.catch(()=>{}),wait(1500)]);if(slide.playState==='running')slide.finish();}await wait(20);};const cardTop=index=>document.querySelectorAll('.card')[index].getBoundingClientRect().top;"
        let steps: [(name: String, body: String, snapshot: String?)] = [
            ("leaving the editor turns back while the page under the pointer stays clickable", "document.querySelector('.form-footer button').click();const add=document.querySelector('header .primary'),box=add.getBoundingClientRect();return !!document.querySelector('header h1')&&turning(app,'turn-back')&&document.elementFromPoint(box.left+box.width/2,box.top+box.height/2).closest('button')===add;", nil),
            ("opening settings turns forward and the page is already there", "document.querySelector('header .group button').click();return !!document.querySelector('header h2')&&!!document.querySelector('.segments.tabs')&&turning(app,'turn-forward');", nil),
            ("switching to About moves only the content and keeps keyboard focus", "const header=document.querySelector('header'),tabs=document.querySelector('.segments.tabs'),old=document.querySelector('.sheet'),about=tabs.children[1];about.focus();about.click();const sheet=document.querySelector('.sheet');return header===document.querySelector('header')&&tabs===document.querySelector('.segments.tabs')&&sheet!==old&&document.activeElement===about&&about.classList.contains('chosen')&&about.getAttribute('aria-pressed')==='true'&&sheet.querySelectorAll('button.uninstall').length===1&&turning(sheet,'turn-forward')&&header.getAnimations().length===0&&tabs.getAnimations().length===0;", nil),
            ("a click during that transition still switches back", "const tabs=document.querySelector('.segments.tabs'),general=tabs.children[0];general.click();const sheet=document.querySelector('.sheet');return general.classList.contains('chosen')&&!tabs.children[1].classList.contains('chosen')&&sheet.querySelectorAll('.segments').length===3&&turning(sheet,'turn-back');", nil),
            ("settings options are rounded groups without overlap, autostart is a switch, hover fades in 110 ms", "const groups=[...document.querySelectorAll('.sheet .segments')];const tidy=groups.length===3&&groups.every(group=>{const frame=group.getBoundingClientRect(),boxes=[...group.children].map(option=>option.getBoundingClientRect());return group.querySelectorAll('.chosen').length===1&&getComputedStyle(group).borderTopLeftRadius==='12px'&&getComputedStyle(group.children[0]).borderTopLeftRadius==='8px'&&boxes.every((box,i)=>box.left>=frame.left&&box.right<=frame.right&&box.top>frame.top&&box.bottom<frame.bottom&&(i===0||box.left>=boxes[i-1].right-.5));});const box=document.querySelector('input.switch'),look=getComputedStyle(box),thumb=getComputedStyle(box,'::before'),hover=getComputedStyle(groups[0].children[0]);return tidy&&box.type==='checkbox'&&box.getAttribute('role')==='switch'&&look.width==='44px'&&look.height==='24px'&&thumb.width==='18px'&&(reduced?hover.transitionDuration==='0s':hover.transitionProperty.startsWith('background-color')&&hover.transitionDuration.startsWith('0.11s'));", nil),
            ("choosing a theme marks it at once, fades in 110 ms and does not rebuild the group", "window.cmcpTest.showSettings('dark','en');const group=document.querySelectorAll('.sheet .segments')[1],light=group.children[0];void light.offsetWidth;light.click();const immediate=light.classList.contains('chosen')&&light.getAttribute('aria-pressed')==='true'&&group.querySelectorAll('.chosen').length===1&&fading(light,'background-color',110);const saved=await until(()=>document.documentElement.dataset.theme==='light');await wait(60);return immediate&&saved&&light.isConnected&&light.classList.contains('chosen');", nil),
            ("changing the language rebuilds the page but keeps keyboard focus on the choice", "const zh=document.querySelector('.sheet .segments.compact').children[0];zh.focus();zh.click();const saved=await until(()=>document.querySelector('header h2').textContent==='设置');const now=document.activeElement;await wait(250);return saved&&now!==zh&&now.dataset.focusKey==='界面语言:zh-CN'&&now.classList.contains('chosen')&&document.body.scrollWidth<=window.innerWidth;", "mac-settings.png"),
            ("the autostart switch is on screen for the snapshot", "const box=document.querySelector('input.switch');box.scrollIntoView({block:'center'});await wait(100);const rect=box.getBoundingClientRect();return rect.top>=0&&rect.bottom<=window.innerHeight;", "mac-settings-switch.png"),
            ("going back turns back to the card list", "document.querySelector('header button').click();return !!document.querySelector('header h1')&&turning(app,'turn-back');", nil),
            ("expanding a card slides for 170 ms and the card below moves down", "const card=document.querySelector('.card'),head=card.querySelector('.card-head'),accordion=card.querySelector('.accordion'),before=cardTop(1);void head.offsetHeight;head.click();const started=card.classList.contains('expanded')&&head.getAttribute('aria-expanded')==='true'&&fading(accordion,'grid-template-rows',170);await settle(accordion);await wait(250);return started&&cardTop(1)>before;", "mac-home-expanded.png"),
            ("collapsing a card slides for 170 ms and the card below moves back", "const card=document.querySelector('.card'),head=card.querySelector('.card-head'),accordion=card.querySelector('.accordion'),before=cardTop(1);void head.offsetHeight;head.click();const started=!card.classList.contains('expanded')&&head.getAttribute('aria-expanded')==='false'&&fading(accordion,'grid-template-rows',170);await settle(accordion);return started&&cardTop(1)<before;", nil)
        ]
        let forceMotion = "const sheet=document.styleSheets[0],rule=[...sheet.cssRules].findIndex(item=>item.cssText.includes('prefers-reduced-motion'));if(rule<0)return false;sheet.deleteRule(rule);window.cmcpMotionForced=true;window.cmcpTest.showEditor();return getComputedStyle(document.querySelector('.form-footer button')).transitionDuration.startsWith('0.11s');"
        func next(_ index: Int, _ pass: String, then done: @escaping () -> Void) {
            guard index < steps.count else { done(); return }
            let step = steps[index]
            web.callAsyncJavaScript(shared + step.body, arguments: [:], in: nil, in: .page) { result in
                guard case .success(let value) = result, (value as? Bool) == true else { self.finishTests(error: "Motion check failed: " + pass + ": " + step.name + " (" + String(describing: result) + ")"); return }
                self.motionResults.append(pass + ": " + step.name)
                if let snapshot = step.snapshot { self.saveSnapshot(snapshot) { next(index + 1, pass, then: done) } } else { next(index + 1, pass, then: done) }
            }
        }
        web.evaluateJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches") { value, _ in
            self.reducedMotion = value as? Bool ?? false
            next(0, self.reducedMotion ? "reduced motion" : "animated") {
                self.web.callAsyncJavaScript(forceMotion, arguments: [:], in: nil, in: .page) { result in
                    guard case .success(let value) = result, (value as? Bool) == true else { self.finishTests(error: "Could not turn off the reduced-motion rule (" + String(describing: result) + ")"); return }
                    next(0, "animated") { self.finishTests(error: nil) }
                }
            }
        }
    }
    func finishTests(error: String?) {
        if let folder = reportDirectory {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let result: [String: Any] = ["passed": testResults.count, "failed": error == nil ? 0 : 1, "error": error ?? "", "checks": testResults, "motion_checks": motionResults, "reduced_motion": reducedMotion, "not_executed": ["real cloud connection", "user TCC permissions", "real login item approval", "how the animations look on a real Mac display"]]
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
