import AppKit
import Foundation
import WebKit

private let uiPort = 3860
private let uiHost = "127.0.0.1"
private let uiURL = URL(string: "http://\(uiHost):\(uiPort)/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var server: Process?
  private var healthTimer: Timer?
  private var healthAttempts = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    buildWindow()
    startDesktopServer()
    beginHealthPolling()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    healthTimer?.invalidate()
    if let server, server.isRunning {
      server.terminate()
      server.waitUntilExit()
    }
  }

  private func buildWindow() {
    let rect = NSRect(x: 0, y: 0, width: 720, height: 780)
    window = NSWindow(
      contentRect: rect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Cursor Chat"
    window.center()
    window.setFrameAutosaveName("CursorChatMain")
    window.isReleasedWhenClosed = false

    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    webView = WKWebView(frame: rect, configuration: config)
    webView.navigationDelegate = self
    webView.autoresizingMask = [.width, .height]
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)

    let loading = URLRequest(url: URL(string: "data:text/html,<html><body style='font-family:-apple-system;padding:40px;color:#333'>Iniciando Cursor Chat…</body></html>")!)
    webView.load(loading)
  }

  private func repoRoot() -> URL? {
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    // …/apps/CursorChat.app/Contents/MacOS/CursorChat → repo root
    var url = exe
    for _ in 0..<5 {
      url.deleteLastPathComponent()
    }
    let marker = url.appendingPathComponent("scripts/cursor-chat-desktop.mjs")
    if FileManager.default.fileExists(atPath: marker.path) {
      return url
    }
    return nil
  }

  private func hostArch() -> String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x86_64"
    #endif
  }

  private func binaryArch(_ path: String) -> String? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/file")
    task.arguments = ["-b", path]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
      try task.run()
      task.waitUntilExit()
      let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      if out.contains("arm64") { return "arm64" }
      if out.contains("x86_64") { return "x86_64" }
    } catch {}
    return nil
  }

  private func shellNodePaths() -> [String] {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/bash")
    task.arguments = ["-lc", "command -v node; type -ap node 2>/dev/null"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
      try task.run()
      task.waitUntilExit()
      let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      return out
        .split(separator: "\n")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    } catch {
      return []
    }
  }

  private func findNode() -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    var candidates: [String] = [
      "\(home)/.local/node-20/bin/node",
      "\(home)/.local/node/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
    ]
    candidates.insert(contentsOf: shellNodePaths(), at: 0)

    let nvmRoot = "\(home)/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot) {
      for ver in versions.sorted().reversed() {
        candidates.insert("\(nvmRoot)/\(ver)/bin/node", at: 0)
      }
    }

    let wanted = hostArch()
    var fallback: String?
    var seen = Set<String>()
    for path in candidates {
      guard !seen.contains(path) else { continue }
      seen.insert(path)
      guard FileManager.default.isExecutableFile(atPath: path) else { continue }
      if binaryArch(path) == wanted {
        return path
      }
      if fallback == nil { fallback = path }
    }
    return fallback
  }

  private func alertAndQuit(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Cursor Chat"
    alert.informativeText = message
    alert.alertStyle = .critical
    alert.runModal()
    NSApp.terminate(nil)
  }

  private func startDesktopServer() {
    guard let root = repoRoot() else {
      alertAndQuit("No se encontró la raíz del proyecto (scripts/cursor-chat-desktop.mjs).")
      return
    }
    guard let node = findNode() else {
      alertAndQuit("No se encontró Node.js. Instala Node o agrégalo al PATH.")
      return
    }

    let script = root.appendingPathComponent("scripts/cursor-chat-desktop.mjs")
    let appPath = root.appendingPathComponent("apps/CursorChat.app")

    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [script.path]
    process.currentDirectoryURL = root
    var env = ProcessInfo.processInfo.environment
    env["CURSOR_CHAT_APP_BUNDLE"] = "1"
    env["CURSOR_CHAT_APP_PATH"] = appPath.path
    env["CURSOR_CHAT_SKIP_WINDOW"] = "1"
    process.environment = env
    process.standardOutput = FileHandle.standardOutput
    process.standardError = FileHandle.standardError
    process.terminationHandler = { _ in
      DispatchQueue.main.async {
        NSApp.terminate(nil)
      }
    }

    do {
      try process.run()
      server = process
    } catch {
      alertAndQuit("No se pudo iniciar el servidor: \(error.localizedDescription)")
    }
  }

  private func beginHealthPolling() {
    healthTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      self.healthAttempts += 1
      if self.healthAttempts > 80 {
        timer.invalidate()
        self.alertAndQuit("El servidor no respondió en http://\(uiHost):\(uiPort).")
        return
      }
      self.checkHealth { ok in
        if ok {
          timer.invalidate()
          self.webView.load(URLRequest(url: uiURL))
          self.window.makeKeyAndOrderFront(nil)
          NSApp.activate(ignoringOtherApps: true)
        }
      }
    }
  }

  private func checkHealth(completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: URL(string: "http://\(uiHost):\(uiPort)/api/health")!)
    request.timeoutInterval = 0.8
    URLSession.shared.dataTask(with: request) { _, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { completion(ok) }
    }.resume()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
