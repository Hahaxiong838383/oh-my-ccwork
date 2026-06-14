// cc-monitor — 菜单栏 + 桌面悬浮窗，实时显示 cc 系统运行状态
// 数据源：~/.claude/hooks/cc-status.sh --json（每 30s 轮询）
// 编译：swiftc -swift-version 5 cc-monitor.swift -o cc-monitor
// 2026-06-14 建。形态=菜单栏图标 + 可钉悬浮面板；技术=SwiftUI(AppKit 壳)
import AppKit
import SwiftUI
import Foundation

struct CCStatus {
    var ts = "—"
    var rulesKB = 0, memKB = 0, eventsKB = 0
    var rulesTrip = 12, memTrip = 12, eventsTrip = 60
    var cards = 0, mcp = 0, sessions = 0, gitDirty = 0
    var gitTag = "—", gitLast = "—"
    var engines: [(String, Bool)] = []
    var secretHook = false
}

final class StatusStore: ObservableObject {
    @Published var s = CCStatus()
    let scriptPath = ("~/.claude/hooks/cc-status.sh" as NSString).expandingTildeInPath

    func refresh() {
        DispatchQueue.global().async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            task.arguments = [self.scriptPath, "--json"]
            let pipe = Pipe()
            task.standardOutput = pipe
            do {
                try task.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
                guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                let parsed = StatusStore.parse(obj)
                DispatchQueue.main.async { self.s = parsed }
            } catch { }
        }
    }

    static func parse(_ o: [String: Any]) -> CCStatus {
        var st = CCStatus()
        st.ts = o["ts"] as? String ?? "—"
        if let b = o["budget"] as? [String: Any] {
            st.rulesKB = b["rules_kb"] as? Int ?? 0
            st.memKB = b["memory_kb"] as? Int ?? 0
            st.eventsKB = b["events_kb"] as? Int ?? 0
            st.rulesTrip = b["rules_trip"] as? Int ?? 12
            st.memTrip = b["memory_trip"] as? Int ?? 12
            st.eventsTrip = b["events_trip"] as? Int ?? 60
        }
        st.cards = o["memory_cards"] as? Int ?? 0
        st.mcp = o["mcp"] as? Int ?? 0
        st.sessions = o["sessions"] as? Int ?? 0
        st.secretHook = o["secret_hook"] as? Bool ?? false
        if let g = o["git"] as? [String: Any] {
            st.gitDirty = g["dirty"] as? Int ?? 0
            st.gitTag = g["tag"] as? String ?? "—"
            st.gitLast = g["last"] as? String ?? "—"
        }
        if let e = o["engines"] as? [String: Any] {
            st.engines = ["omp","grok","codex","gemini","gateway"].map { ($0, e[$0] as? Bool ?? false) }
        }
        return st
    }

    var healthy: Bool {
        s.rulesKB <= s.rulesTrip && s.memKB <= s.memTrip && s.eventsKB <= s.eventsTrip
        && s.secretHook && (s.engines.isEmpty || s.engines.allSatisfy { $0.1 })
    }
}

struct BudgetBar: View {
    let label: String; let v: Int; let trip: Int
    var over: Bool { v > trip }
    var body: some View {
        HStack(spacing: 8) {
            Text(label).frame(width: 60, alignment: .leading).font(.system(size: 11))
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.gray.opacity(0.2))
                    RoundedRectangle(cornerRadius: 3)
                        .fill(over ? Color.orange : Color.green)
                        .frame(width: min(CGFloat(v) / CGFloat(max(trip, 1)), 1.0) * geo.size.width)
                }
            }.frame(height: 8)
            Text("\(v)/\(trip)").frame(width: 44, alignment: .trailing).font(.system(size: 10)).foregroundColor(.secondary)
        }
    }
}

struct ContentView: View {
    @ObservedObject var store: StatusStore
    var s: CCStatus { store.s }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("🧠 cc 系统状态").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(s.ts).font(.system(size: 10)).foregroundColor(.secondary)
            }
            Divider()
            Text("常驻预算 (KB)").font(.system(size: 11, weight: .medium)).foregroundColor(.secondary)
            BudgetBar(label: "rules", v: s.rulesKB, trip: s.rulesTrip)
            BudgetBar(label: "MEMORY", v: s.memKB, trip: s.memTrip)
            BudgetBar(label: "events", v: s.eventsKB, trip: s.eventsTrip)
            Divider()
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("记忆 \(s.cards) 卡").font(.system(size: 11))
                    Text("MCP \(s.mcp) · session \(s.sessions)").font(.system(size: 11))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(s.gitDirty == 0 ? "git 干净 ✅" : "git \(s.gitDirty) 未提交 ⚠️").font(.system(size: 11))
                    Text("tag \(s.gitTag) · 闸 \(s.secretHook ? "✅" : "⚠️")").font(.system(size: 11))
                }
            }
            Divider()
            Text("引擎团队").font(.system(size: 11, weight: .medium)).foregroundColor(.secondary)
            HStack(spacing: 11) {
                ForEach(s.engines, id: \.0) { item in
                    HStack(spacing: 3) {
                        Circle().fill(item.1 ? Color.green : Color.red).frame(width: 7, height: 7)
                        Text(item.0).font(.system(size: 10))
                    }
                }
            }
            Divider()
            HStack {
                Button("刷新") { store.refresh() }.font(.system(size: 11))
                Spacer()
                Button("退出") { NSApp.terminate(nil) }.font(.system(size: 11))
            }
        }
        .padding(14)
        .frame(width: 320)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var panel: NSPanel!
    let store = StatusStore()
    var timer: Timer?

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)

        let hosting = NSHostingView(rootView: ContentView(store: store))
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 380),
                        styleMask: [.titled, .closable, .nonactivatingPanel, .utilityWindow],
                        backing: .buffered, defer: false)
        panel.title = "cc 监视器"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = hosting

        store.refresh()
        updateIcon()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.store.refresh()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.updateIcon() }
        }
    }

    func updateIcon() {
        let ok = store.healthy
        statusItem.button?.attributedTitle = NSAttributedString(
            string: ok ? "cc ●" : "cc ▲",
            attributes: [.foregroundColor: ok ? NSColor.systemGreen : NSColor.systemOrange,
                         .font: NSFont.systemFont(ofSize: 13)])
    }

    @objc func togglePanel() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            if let b = statusItem.button, let w = b.window {
                let r = w.convertToScreen(b.frame)
                panel.setFrameTopLeftPoint(NSPoint(x: r.minX - 150, y: r.minY - 6))
            }
            store.refresh()
            panel.orderFrontRegardless()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
