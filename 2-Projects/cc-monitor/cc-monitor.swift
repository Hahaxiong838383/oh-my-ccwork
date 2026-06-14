// cc-monitor — 菜单栏图标(MenuBarExtra) + 点击弹出状态/架构面板
// 数据源：~/.claude/hooks/cc-status.sh --json（每 30s 轮询）
// 编译：swiftc -swift-version 5 cc-monitor.swift -o cc-monitor
// 用 SwiftUI 原生 MenuBarExtra（系统管菜单栏渲染，比手搓 NSStatusItem 可靠）
import SwiftUI
import Foundation
import AppKit
import Combine        // ObservableObject/@Published(Xcode 26 MemberImportVisibility 要求显式导入)
import CoreServices   // FSEvents 文件监听

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
    private var timer: Timer?
    private var fsStream: FSEventStreamRef?
    private var debounce: DispatchWorkItem?
    private var running = false

    init() { refresh() }   // 首屏先拉一次;轮询/监听由 start() 控制(面板可见才开,关窗暂停=省电)

    // 面板可见时调:3s 轮询 + FSEvents 文件监听(双保险:文件即时事件 + 定时兜底引擎/session 状态)
    func start() {
        guard !running else { return }
        running = true
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        startWatching()
    }

    // 面板隐藏/关闭时调:停轮询 + 停监听(后台零开销)
    func stop() {
        running = false
        timer?.invalidate(); timer = nil
        stopWatching()
        debounce?.cancel(); debounce = nil
    }

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

    // ── FSEvents:监听 rules/memory/git/events 目录,文件一改即触发刷新(防抖合并) ──
    private func startWatching() {
        let paths = [
            "~/.claude/rules",
            "~/.claude/projects/-Users-rayman-chen-mycc/memory",
            "~/.claude/.git",
            "~/mycc/0-System",
        ].map { ($0 as NSString).expandingTildeInPath } as CFArray
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                       retain: nil, release: nil, copyDescription: nil)
        let cb: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info = info else { return }
            Unmanaged<StatusStore>.fromOpaque(info).takeUnretainedValue().fsTriggered()
        }
        guard let stream = FSEventStreamCreate(kCFAllocatorDefault, cb, &ctx, paths,
                FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3,
                FSEventStreamCreateFlags(kFSEventStreamCreateFlagNoDefer)) else { return }
        fsStream = stream
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
    }

    private func stopWatching() {
        guard let st = fsStream else { return }
        FSEventStreamStop(st); FSEventStreamInvalidate(st); FSEventStreamRelease(st)
        fsStream = nil
    }

    private func fsTriggered() {
        debounce?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.refresh() }
        debounce = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)   // 0.4s 防抖:合并编辑器多次保存/git 批量写
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
    @State private var tab = 0
    var s: CCStatus { store.s }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("🧠 cc").font(.system(size: 13, weight: .semibold))
                Picker("", selection: $tab) {
                    Text("状态").tag(0); Text("架构").tag(1)
                }.pickerStyle(.segmented).labelsHidden().frame(width: 130)
                Spacer()
                Text(s.ts).font(.system(size: 9)).foregroundColor(.secondary)
            }
            Divider()
            ScrollView {
                if tab == 0 { statusView } else { archView }
            }
            .frame(maxHeight: 520)
            Divider()
            HStack {
                Button("刷新") { store.refresh() }.font(.system(size: 11))
                Spacer()
                if tab == 1 { Text("点路径→Finder 打开").font(.system(size: 9)).foregroundColor(.secondary) }
                Spacer()
                Button("退出") { NSApp.terminate(nil) }.font(.system(size: 11))
            }
        }
        .padding(14)
        .frame(width: 360)
        .onAppear { store.start() }      // popover 打开 → 开始刷新+监听
        .onDisappear { store.stop() }    // popover 关闭 → 暂停(省电)
    }

    var statusView: some View {
        VStack(alignment: .leading, spacing: 9) {
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
        }
    }

    // ── 架构 tab：每层 = 一张卡，列出真实子目录路径 + 作用，点路径在 Finder 打开 ──
    var archView: some View {
        VStack(alignment: .leading, spacing: 6) {
            legend
            layerCard("① 常驻核心", badge: "rules \(s.rulesKB)K·MEM \(s.memKB)K",
                      ok: s.rulesKB <= s.rulesTrip && s.memKB <= s.memTrip) {
                pathRow(.green, "~/.claude/rules/", "5 文件·身份/行为/流程/工具/路由·每次注入")
                pathRow(.green, "~/.claude/projects/-Users-rayman-chen-mycc/memory/MEMORY.md", "热索引 46★·每次注入")
                pathRow(.green, "~/mycc/CLAUDE.md", "项目入口·cwd=mycc 时常驻")
            }
            arrow("↓ 按需 pull · ripgrep / read")
            layerCard("② 按需召回", badge: "\(s.cards) 记忆卡", ok: true) {
                pathRow(.blue, "~/.claude/docs/", "engine-ops·no-guessing·patterns…")
                pathRow(.blue, "~/.claude/projects/-Users-rayman-chen-mycc/memory/", "\(s.cards) 卡·INDEX-full·ripgrep 召回")
                pathRow(.blue, "~/.claude/skills/", "全局 skill 17")
                pathRow(.blue, "~/mycc/.claude/skills/", "项目 skill 80")
            }
            arrow("↓ cc 编排")
            layerCard("③ 项目 ~/mycc", badge: "PARA·MCP \(s.mcp)", ok: true) {
                pathRow(.gray, "~/mycc/0-System/", "status·RECENT_EVENTS·task-log")
                pathRow(.gray, "~/mycc/{1-Inbox…5-Archive}/", "PARA 五区·分类归档", open: "~/mycc")
                pathRow(.gray, "~/mycc/.mcp.json", "项目 MCP \(s.mcp) 个·飞书/wiki/gateway")
                pathRow(.gray, "~/mycc/docs/rules/ · multi-agent/", "P2/P3 规则·多智能体协同", open: "~/mycc/docs/rules")
            }
            arrow("↓ routing-kernel 路由")
            engineCard
            arrow("⊘ 隔离 · 不外派 / 不 memory / 不 git")
            layerCard("⑤ work-private", badge: "隐私 vault", ok: true, muted: true) {
                pathRow(.gray, "~/work-private/", "人事/面试/客户·三不墙(独立·非 git)")
            }
            Divider().padding(.vertical, 1)
            govCard
        }
    }

    var legend: some View {
        HStack(spacing: 12) {
            legendDot(.green, "常驻 每次注入")
            legendDot(.blue, "按需 召回")
            legendDot(.gray, "运行时")
        }.padding(.bottom, 1)
    }
    func legendDot(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 3) {
            Circle().fill(c).frame(width: 6, height: 6)
            Text(t).font(.system(size: 8)).foregroundColor(.secondary)
        }
    }

    // ④ 引擎团队：状态点 + 各 CLI 配置根路径
    var engineCard: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle().fill(!s.engines.isEmpty && s.engines.allSatisfy { $0.1 } ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text("④ 引擎团队").font(.system(size: 11.5, weight: .semibold))
                Spacer()
                HStack(spacing: 6) {
                    ForEach(s.engines, id: \.0) { e in
                        HStack(spacing: 2) {
                            Circle().fill(e.1 ? Color.green : Color.red).frame(width: 5, height: 5)
                            Text(e.0).font(.system(size: 8))
                        }
                    }
                }
            }
            pathRow(.gray, "~/.omp/", "omp 多 provider 编排·agent.db")
            pathRow(.gray, "~/.grok/ · ~/.codex/ · ~/.gemini/", "各引擎 CLI 配置根", open: "~/.codex")
            pathRow(.gray, "~/.gateway.env", "codex 网关 key·chmod 600")
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.gray.opacity(0.07)))
    }

    // 治理闸：hooks
    var govCard: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle().fill(s.secretHook ? Color.green : Color.orange).frame(width: 7, height: 7)
                Text("治理闸").font(.system(size: 11.5, weight: .semibold))
                Spacer()
                Text(s.secretHook ? "secret 闸 active ✅" : "闸 off ⚠️")
                    .font(.system(size: 8.5)).foregroundColor(.secondary)
            }
            pathRow(.gray, "~/.claude/hooks/", "secret-scan·budget-check·cc-status·pre-commit")
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.gray.opacity(0.07)))
    }

    func layerCard<C: View>(_ title: String, badge: String, ok: Bool, muted: Bool = false,
                            @ViewBuilder _ rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle().fill(muted ? Color.gray.opacity(0.5) : (ok ? Color.green : Color.orange))
                    .frame(width: 7, height: 7)
                Text(title).font(.system(size: 11.5, weight: .semibold))
                Spacer()
                Text(badge).font(.system(size: 8.5)).foregroundColor(.secondary)
            }
            rows()
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.gray.opacity(0.07)))
    }

    func pathRow(_ dot: Color, _ path: String, _ role: String, open: String? = nil) -> some View {
        Button(action: { reveal(open ?? path) }) {
            HStack(alignment: .top, spacing: 6) {
                Circle().fill(dot).frame(width: 5, height: 5).padding(.top, 4)
                VStack(alignment: .leading, spacing: 1) {
                    Text(path).font(.system(size: 9.5, design: .monospaced))
                        .foregroundColor(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    Text(role).font(.system(size: 8.5)).foregroundColor(.secondary)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    func arrow(_ t: String) -> some View {
        Text(t).font(.system(size: 8)).foregroundColor(.secondary)
            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 1)
    }

    // 点路径：目录→Finder 打开；文件→Finder 选中（便于右键编辑）
    func reveal(_ tilde: String) {
        let p = (tilde as NSString).expandingTildeInPath
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: p, isDirectory: &isDir) {
            if isDir.boolValue {
                NSWorkspace.shared.open(URL(fileURLWithPath: p))
            } else {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
            }
        }
    }
}

@main
struct CCMonitorApp: App {
    @StateObject private var store = StatusStore()
    var body: some Scene {
        MenuBarExtra {
            ContentView(store: store)
        } label: {
            Image(systemName: store.healthy ? "gauge.medium" : "exclamationmark.triangle.fill")
        }
        .menuBarExtraStyle(.window)
    }
}
