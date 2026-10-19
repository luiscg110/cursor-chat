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
  private var healthInFlight = false
  private var ownsServer = false
  private var uiLoaded = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    buildWindow()
    NSApp.activate(ignoringOtherApps: true)

    // Prefer an already-healthy server (macOS window restore / second launch)
    checkHealth { [weak self] ok in
      guard let self else { return }
      if ok {
        self.loadUI()
        return
      }
      // Port may be occupied by a stuck process — only then start ours
      self.startDesktopServer()
      self.beginHealthPolling()
    }
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
    // Keep Node alive if a 24h continuous session is in progress — closing the
    // window must not abort mid-turn (that left state.running=true with no server).
    if ownsServer, let server, server.isRunning {
      if continuousRunningOnDisk() {
        // Detach: Node keeps serving; reopen the app to reconnect.
        ownsServer = false
        self.server = nil
        return
      }
      server.terminate()
      server.waitUntilExit()
    }
  }

  /// Reads logs/continuous/state.json without requiring HTTP (server may be busy).
  private func continuousRunningOnDisk() -> Bool {
    guard let root = repoRoot() else { return false }
    let path = root.appendingPathComponent("logs/continuous/state.json")
    guard let data = try? Data(contentsOf: path),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let running = obj["running"] as? Bool
    else { return false }
    if !running { return false }
    if let ends = obj["endsAt"] as? String {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let endDate = formatter.date(from: ends) ?? ISO8601DateFormatter().date(from: ends) {
        return endDate > Date()
      }
    }
    return true
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

  private func loadUI() {
    guard !uiLoaded else { return }
    uiLoaded = true
    healthTimer?.invalidate()
    healthTimer = nil
    webView.load(URLRequest(url: uiURL))
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
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
    process.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self else { return }
        // exit 0 = another healthy instance already owns the port
        if proc.terminationStatus == 0 {
          self.ownsServer = false
          self.server = nil
          self.checkHealth { ok in
            if ok {
              self.loadUI()
            } else {
              self.alertAndQuit("El servidor salió sin quedar disponible en http://\(uiHost):\(uiPort).")
            }
          }
          return
        }
        if !self.uiLoaded {
          self.alertAndQuit("El servidor Node terminó inesperadamente (código \(proc.terminationStatus)).")
        }
      }
    }

    do {
      try process.run()
      server = process
      ownsServer = true
    } catch {
      alertAndQuit("No se pudo iniciar el servidor: \(error.localizedDescription)")
    }
  }

  private func beginHealthPolling() {
    healthAttempts = 0
    healthInFlight = false
    // Start at 0.4s; no overlapping requests
    healthTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      if self.uiLoaded {
        timer.invalidate()
        return
      }
      if self.healthInFlight { return }

      self.healthAttempts += 1
      if self.healthAttempts > 50 {
        timer.invalidate()
        self.alertAndQuit("El servidor no respondió en http://\(uiHost):\(uiPort).")
        return
      }

      self.healthInFlight = true
      self.checkHealth { [weak self] ok in
        guard let self else { return }
        self.healthInFlight = false
        if ok {
          self.loadUI()
        }
      }
    }
  }

  private func checkHealth(completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: URL(string: "http://\(uiHost):\(uiPort)/api/health")!)
    request.timeoutInterval = 0.6
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let code = (response as? HTTPURLResponse)?.statusCode == 200
      var appOk = false
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let app = obj["app"] as? String {
        appOk = app == "cursor-chat"
      }
      DispatchQueue.main.async { completion(code && appOk) }
    }.resume()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Regular policy → Dock icon + running indicator (dot) while open
app.setActivationPolicy(.regular)
app.run()
