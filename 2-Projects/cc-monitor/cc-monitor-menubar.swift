// cc-monitor (Dock 版) — 普通 app，Dock 图标点击=打开状态/架构面板
// 不用 LSUIElement(所以有 Dock 图标);窗口渲染可靠,绕开菜单栏 accessory 渲染坑
// 编译：swiftc -swift-version 5 cc-monitor-dock.swift -o cc-monitor-dock
import AppKit
import SwiftUI
import Foundation
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
    // skills 自进化(诚实命名:evoActive=活跃未毕业改进项/进化债; frictionTop=周边热度近似非精确计数)
    var skillTotal = 0, evoTotal = 0, evoActive = 0, evoStaleDays = 0
    var evoId = "—", evoColor = "", evoProblem = ""
    var frictionTop: [(String, Int)] = []
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
            // GUI app 从 LaunchServices 启动时环境可能精简,显式补全 PATH+HOME(健壮兜底)
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:" + (env["PATH"] ?? "")
            env["HOME"] = NSHomeDirectory()
            task.environment = env
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
        if let sk = o["skills"] as? [String: Any] {
            st.skillTotal = sk["total"] as? Int ?? 0
            st.evoTotal = sk["evo_total"] as? Int ?? 0
            st.evoActive = sk["evo_pending"] as? Int ?? 0
            st.evoStaleDays = sk["evo_stale_days"] as? Int ?? 0
            if let el = sk["evo_latest"] as? [String: Any] {
                st.evoId = el["id"] as? String ?? "—"
                st.evoColor = el["color"] as? String ?? ""
                st.evoProblem = el["problem"] as? String ?? ""
            }
            if let ft = sk["friction_top"] as? [[String: Any]] {
                st.frictionTop = ft.compactMap {
                    guard let n = $0["name"] as? String, let c = $0["count"] as? Int else { return nil }
                    return (n, c)
                }
            }
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
                    Text("状态").tag(0); Text("架构").tag(1); Text("skills").tag(2)
                }.pickerStyle(.segmented).labelsHidden().frame(width: 178)
                Spacer()
                Text(s.ts).font(.system(size: 9)).foregroundColor(.secondary)
            }
            Divider()
            ScrollView {
                if tab == 0 { statusView } else if tab == 1 { archView } else { skillsView }
            }
            .frame(maxHeight: 520)
            Divider()
            HStack {
                Button("刷新") { store.refresh() }.font(.system(size: 11))
                Spacer()
                if tab == 1 { Text("点路径→Finder 打开").font(.system(size: 9)).foregroundColor(.secondary) }
                if tab == 2 { Text("friction=周边热度近似").font(.system(size: 9)).foregroundColor(.secondary) }
                Spacer()
                Button("退出") { NSApp.terminate(nil) }.font(.system(size: 11))
            }
        }
        .padding(14)
        .frame(width: 360)
        .onAppear { store.start() }
        .onDisappear { store.stop() }
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
                        .onTapGesture { reveal("~/.claude") }
                        .help(s.gitDirty == 0 ? "~/.claude 工作区干净" : "~/.claude 有 \(s.gitDirty) 个文件未提交 · 点击在 Finder 打开去手动提交(监视器只读不替你提交)")
                    Text("tag \(s.gitTag) · 闸 \(s.secretHook ? "✅" : "⚠️")").font(.system(size: 11))
                        .help("tag = git 版本锚点(架构迁移完成的标记,可一键回退到稳定点) · 闸 = secret-scan pre-commit hook(提交 ~/.claude 时自动扫硬编码密钥,防泄露)")
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
    // ── 架构 tab：左偏轴管道流转图(地铁线主干贯穿 + 右侧挂枝) ──
    var archView: some View {
        VStack(alignment: .leading, spacing: 0) {
            legend.padding(.leading, 26).padding(.bottom, 8)
            pipeLayer("①", "常驻核心", "rules \(s.rulesKB)K·MEM \(s.memKB)K",
                      ok: s.rulesKB <= s.rulesTrip && s.memKB <= s.memTrip,
                      nodes: [("rules/", "~/.claude/rules/", false),
                              ("CLAUDE.md", "~/mycc/CLAUDE.md", false),
                              ("memory/MEMORY.md", "~/.claude/projects/-Users-rayman-chen-mycc/memory/MEMORY.md", true)])
            relationRow("↓ 按需 pull · ripgrep")
            pipeLayer("②", "按需召回", "\(s.cards) 卡", ok: true,
                      nodes: [("docs/", "~/.claude/docs/", false),
                              ("\(s.cards) 记忆卡", "~/.claude/projects/-Users-rayman-chen-mycc/memory/", false),
                              ("skills/", "~/.claude/skills/", false),
                              (".claude/skills/", "~/mycc/.claude/skills/", false)])
            relationRow("↓ cc 编排")
            pipeLayer("③", "项目 ~/mycc", "MCP \(s.mcp)", ok: true,
                      nodes: [("0-System/", "~/mycc/0-System/", false),
                              ("PARA 五区", "~/mycc", false),
                              (".mcp.json", "~/mycc/.mcp.json", false)])
            relationRow("↓ routing-kernel 路由")
            engineLayer
            relationRow("⊘ 隔离 · 不外派 / 不 memory / 不 git")
            pipeLayer("⑤", "work-private", "隐私 vault", ok: true, muted: true,
                      nodes: [("人事/面试/客户 vault", "~/work-private", true)], isLast: true)
            govRow
        }
        .padding(.vertical, 4)
    }

    var legend: some View {
        HStack(spacing: 12) {
            legendDot(.green, "健康")
            legendDot(.orange, "超预算/告警")
            legendDot(Color.gray.opacity(0.55), "隔离/中性")
        }
    }
    func legendDot(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 3) {
            Circle().fill(c).frame(width: 6, height: 6)
            Text(t).font(.system(size: 8)).foregroundColor(.secondary)
        }
    }

    // 左主干背景:顶部圆点(健康色) + 向下贯穿竖线(画在 .background,自然填满本块高度,不撑爆 VStack)
    func spineBg(dot: Color, tail: Bool) -> some View {
        ZStack(alignment: .top) {
            if tail {
                Rectangle().fill(Color.gray.opacity(0.3)).frame(width: 2)
                    .frame(maxHeight: .infinity).padding(.top, 5)
            }
            Circle().fill(dot).frame(width: 11, height: 11)
                .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
        }
        .frame(width: 11).padding(.leading, 3)
    }

    // 一个架构层:右侧标题 + 叶节点网格,左侧主干画在 background
    func pipeLayer(_ idx: String, _ title: String, _ badge: String, ok: Bool, muted: Bool = false,
                   nodes: [(String, String, Bool)], isLast: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text(idx).font(.system(size: 12, weight: .bold)).foregroundColor(.secondary)
                Text(title).font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 4)
                Text(badge).font(.system(size: 8.5)).foregroundColor(.secondary)
            }
            nodeGrid(nodes)
        }
        .padding(.leading, 26).padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .topLeading) {
            spineBg(dot: muted ? Color.gray.opacity(0.55) : (ok ? .green : .orange), tail: !isLast)
        }
    }

    // 叶节点 2 列网格(长 label wide=true 占满整行)
    func nodeGrid(_ nodes: [(String, String, Bool)]) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)],
                  alignment: .leading, spacing: 6) {
            ForEach(nodes.indices, id: \.self) { i in
                nodeChip(nodes[i].0, open: nodes[i].1).gridCellColumns(nodes[i].2 ? 2 : 1)
            }
        }
    }

    // 叶节点 chip:点击在 Finder 打开
    func nodeChip(_ label: String, open: String) -> some View {
        Button(action: { reveal(open) }) {
            Text(label).font(.system(size: 10, design: .monospaced))
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 7).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.gray.opacity(0.09)))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.16), lineWidth: 0.5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // 层间关系标签:主干竖线段(对齐圆点 x≈8.5) + 右侧胶囊文字
    func relationRow(_ text: String) -> some View {
        HStack(spacing: 0) {
            Rectangle().fill(Color.gray.opacity(0.3)).frame(width: 2, height: 22).padding(.leading, 7.5)
            Text(text).font(.system(size: 9)).foregroundColor(.secondary)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Capsule().fill(Color.gray.opacity(0.10)))
                .padding(.leading, 9)
            Spacer(minLength: 0)
        }
    }

    // ④ 引擎团队:5 引擎各带在线点,点击开各自配置根
    var engineLayer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text("④").font(.system(size: 12, weight: .bold)).foregroundColor(.secondary)
                Text("引擎团队").font(.system(size: 12, weight: .semibold))
                Spacer()
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)],
                      alignment: .leading, spacing: 6) {
                ForEach(s.engines, id: \.0) { e in engineChip(e.0, e.1) }
            }
        }
        .padding(.leading, 26).padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .topLeading) {
            spineBg(dot: !s.engines.isEmpty && s.engines.allSatisfy { $0.1 } ? .green : .orange, tail: true)
        }
    }
    func engineChip(_ name: String, _ online: Bool) -> some View {
        let path = ["omp": "~/.omp", "grok": "~/.grok", "codex": "~/.codex",
                    "gemini": "~/.gemini", "gateway": "~/.gateway.env"][name] ?? "~"
        return Button(action: { reveal(path) }) {
            HStack(spacing: 5) {
                Circle().fill(online ? Color.green : Color.red).frame(width: 6, height: 6)
                Text(name).font(.system(size: 10, design: .monospaced))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 7).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.gray.opacity(0.09)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // 治理闸:管道末端旁挂(无 tail)
    var govRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text("治理闸").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(s.secretHook ? "secret 闸 ✅" : "闸 off ⚠️")
                    .font(.system(size: 8.5)).foregroundColor(.secondary)
            }
            nodeChip("hooks/", open: "~/.claude/hooks/")
        }
        .padding(.leading, 26)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .topLeading) { spineBg(dot: s.secretHook ? .green : .orange, tail: false) }
    }

    // ── skills tab：自进化状态(Latest Insight + 进化债/停滞 + friction 周边热度) ──
    var skillsView: some View {
        VStack(alignment: .leading, spacing: 10) {
            // 卡片1：最新进化项(Latest Insight) + 进化债/停滞/进化项
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 6) {
                    Text(s.evoColor.isEmpty ? "⚪" : s.evoColor).font(.system(size: 12))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(s.evoId) 最新进化").font(.system(size: 11, weight: .semibold))
                        Text(s.evoProblem).font(.system(size: 9)).foregroundColor(.secondary)
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                HStack(spacing: 18) {
                    statChip("进化债", "\(s.evoActive)", alert: s.evoActive > 5)
                    statChip("停滞", "\(s.evoStaleDays)天", alert: s.evoStaleDays > 14)
                    statChip("进化项", "\(s.evoTotal)")
                    Spacer()
                }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))

            // 卡片2：friction 周边热度 TOP3(Capsule 条形,人对条形敏感>数字)
            VStack(alignment: .leading, spacing: 7) {
                Text("⚠️ 摩擦周边热度 TOP3").font(.system(size: 11, weight: .semibold))
                if s.frictionTop.isEmpty {
                    Text("近期无摩擦记录 ✅").font(.system(size: 9)).foregroundColor(.secondary)
                } else {
                    ForEach(s.frictionTop, id: \.0) { f in
                        HStack(spacing: 6) {
                            Text(f.0).font(.system(size: 10, design: .monospaced))
                                .frame(width: 84, alignment: .leading).lineLimit(1).truncationMode(.middle)
                            GeometryReader { geo in
                                Capsule().fill(Color.orange.opacity(0.7))
                                    .frame(width: max(CGFloat(f.1) / CGFloat(frictionMax) * geo.size.width, 3))
                            }.frame(height: 9)
                            Text("\(f.1)").font(.system(size: 10)).foregroundColor(.secondary)
                                .frame(width: 20, alignment: .trailing)
                        }
                    }
                }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))

            // 底部：skill 库存(小字,非主 KPI) + 点开进化日志
            Button(action: { reveal("~/mycc/0-System/evolution-log.md") }) {
                HStack(spacing: 4) {
                    Text("\(s.skillTotal) skills").font(.system(size: 9, weight: .medium)).foregroundColor(.primary)
                    Text("· 读 evolution-log + task-log · 点开进化日志 ›")
                        .font(.system(size: 8)).foregroundColor(.secondary)
                    Spacer()
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
        .padding(.top, 2)
    }
    var frictionMax: Int { max(s.frictionTop.map { $0.1 }.max() ?? 1, 1) }
    func statChip(_ label: String, _ value: String, alert: Bool = false) -> some View {
        VStack(spacing: 1) {
            Text(value).font(.system(size: 13, weight: .bold)).foregroundColor(alert ? .orange : .primary)
            Text(label).font(.system(size: 8)).foregroundColor(.secondary)
        }
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

// ── 菜单栏外壳:NSStatusItem 图标 + NSPopover 面板 ──
// 用传统 AppKit(非 SwiftUI MenuBarExtra,后者在 macOS 26 此环境不渲染图标);
// dock 版同套 AppKit 已验证窗口渲染正常,NSStatusItem 同底层应可渲染。
@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // 不进 Dock,只待菜单栏
        app.run()
    }

    var statusItem: NSStatusItem!
    let popover = NSPopover()
    let store = StatusStore()
    private var iconSink: AnyCancellable?

    func applicationDidFinishLaunching(_ n: Notification) {
        // 1) 菜单栏图标(变长度,可被 Cmd 拖动)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "cc-monitor-status"   // 记住用户 Cmd 拖动后的位置,下次启动复原
        if let btn = statusItem.button {
            btn.action = #selector(togglePopover)
            btn.target = self
        }
        setIcon(healthy: true)
        // 2) 点击弹出的面板(复用同一 ContentView:状态/架构 + 路径 + 实时刷新)
        popover.contentSize = NSSize(width: 360, height: 620)
        popover.behavior = .transient
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: ContentView(store: store))
        // 3) 健康状态驱动图标(正常=仪表盘 / 异常=警告三角)
        iconSink = store.$s.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.refreshIcon() }
    }

    func refreshIcon() { setIcon(healthy: store.healthy) }

    // SF Symbol 优先;macOS 26 个别 symbol 可能解析为 nil → fallback 纯文字(已验证文字能渲染)
    func setIcon(healthy: Bool) {
        guard let btn = statusItem.button else { return }
        let symbol = healthy ? "gauge.medium" : "exclamationmark.triangle.fill"
        if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "cc") {
            img.isTemplate = true
            btn.image = img
            btn.title = ""
        } else {
            btn.image = nil
            btn.title = healthy ? "✦cc" : "⚠cc"
            btn.font = .systemFont(ofSize: 13, weight: .bold)
        }
    }

    @objc func togglePopover() {
        if popover.isShown { popover.performClose(nil); return }
        guard let btn = statusItem.button else { return }
        popover.show(relativeTo: btn.bounds, of: btn, preferredEdge: .minY)
        store.start()
        NSApp.activate(ignoringOtherApps: true)
    }

    // 面板关闭 → 暂停刷新(后台零开销)
    func popoverDidClose(_ n: Notification) { store.stop() }
}
