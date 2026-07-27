import SwiftUI

struct MenuContentView: View {
    @ObservedObject var model: AppModel
    @State private var showTokenClearConfirmation = false
    @State private var resetAccount: Account?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if model.showSettings || !model.isConfigured {
                settings
            } else {
                serviceStatus
                Divider()
                accounts
                footer
            }
        }
        .padding(16)
        .frame(width: 380)
        .alert("确认清除本机 Token？", isPresented: $showTokenClearConfirmation) {
            Button("取消", role: .cancel) {}
            Button("清除 Token", role: .destructive, action: model.clearToken)
        } message: {
            Text("清除后应用将立即断开 CPA，重新连接需要再次输入 Desktop Token。")
        }
        .confirmationDialog(
            "使用 1 张重置卡？",
            isPresented: Binding(
                get: { resetAccount != nil },
                set: { if !$0 { resetAccount = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("取消", role: .cancel) { resetAccount = nil }
            Button("确认使用", role: .destructive) {
                guard let account = resetAccount else { return }
                resetAccount = nil
                Task { await model.consumeResetCredit(for: account) }
            }
        } message: {
            Text("这会消耗 1 张重置卡并重置该账号当前适用的短周期额度，操作不可撤销。")
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("CPA 状态")
                    .font(.headline)
                Text(model.statusMessage ?? "本机安全读取远端用量")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isRefreshing {
                ProgressView().controlSize(.small)
            }
            Button {
                model.showSettings.toggle()
            } label: {
                Image(systemName: model.showSettings ? "xmark" : "gearshape")
            }
            .buttonStyle(.plain)
        }
    }

    private var serviceStatus: some View {
        HStack(spacing: 8) {
            serviceBadge("CPA", healthy: model.summary?.services["cliproxy"])
            serviceBadge("Router", healthy: model.summary?.services["router"])
            Spacer()
            let codexCount = model.summary?.codexAccounts ?? model.accounts.filter { $0.provider == "codex" }.count
            let k12Count = model.summary?.k12Accounts ?? model.accounts.filter(\.isK12).count
            Text("\(codexCount) 个 Codex · \(k12Count) 个 K12")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var accounts: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.accounts.isEmpty {
                ContentUnavailableView("暂无账号", systemImage: "person.crop.circle.badge.questionmark")
                    .frame(maxWidth: .infinity, minHeight: 100)
            } else {
                ForEach(model.accounts) { account in
                    AccountRow(
                        account: account,
                        isResetting: model.resettingAccountID == account.id,
                        onRequestReset: { resetAccount = account }
                    )
                }
            }
            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    private var footer: some View {
        HStack {
            Button {
                Task { await model.refresh() }
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .disabled(model.isRefreshing)

            Button(action: model.addCodexAuthorization) {
                Label(model.isAuthorizing ? "等待授权" : "添加 Codex 授权", systemImage: "person.badge.plus")
            }
            .disabled(model.isAuthorizing)

            Spacer()
            Button("退出") { NSApplication.shared.terminate(nil) }
        }
        .buttonStyle(.borderless)
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("连接设置").font(.subheadline.bold())
            TextField("Bridge 地址", text: $model.endpoint)
                .textFieldStyle(.roundedBorder)
            SecureField(model.isConfigured ? "Desktop Token（留空不修改）" : "Desktop Token", text: $model.tokenInput)
                .textFieldStyle(.roundedBorder)
            HStack {
                Text("自动刷新")
                Slider(value: $model.refreshMinutes, in: 1...30, step: 1)
                Text("\(Int(model.refreshMinutes)) 分")
                    .monospacedDigit()
                    .frame(width: 42, alignment: .trailing)
            }
            Toggle("开机自动启动", isOn: $model.launchAtLogin)
            if let error = model.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                Button("保存并连接", action: model.saveSettings)
                    .buttonStyle(.borderedProminent)
                if model.isConfigured {
                    Button("清除本机 Token", role: .destructive) {
                        showTokenClearConfirmation = true
                    }
                }
                Spacer()
                Button("退出") { NSApplication.shared.terminate(nil) }
            }
        }
    }

    private func serviceBadge(_ title: String, healthy: Bool?) -> some View {
        Label(title, systemImage: healthy == true ? "checkmark.circle.fill" : "xmark.circle.fill")
            .font(.caption.bold())
            .foregroundStyle(healthy == true ? .green : .red)
    }
}

private struct AccountRow: View {
    let account: Account
    let isResetting: Bool
    let onRequestReset: () -> Void

    var body: some View {
        let usage = account.usageSnapshot
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(account.emailMasked).font(.subheadline.bold())
                    Text(account.isK12 ? "K12" : (usage.planType ?? account.plan ?? account.provider).uppercased())
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if account.hasRefreshToken {
                    Label("可自动刷新", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption2)
                        .foregroundStyle(.green)
                }
            }

            if account.usageStatus == "ok" {
                quotaRow("每周", remaining: usage.weeklyRemainingPercent, reset: usage.weeklyResetSeconds)
                creditsRow
            } else {
                Text(account.usageError ?? (account.disabled ? "账号已停用" : "暂时无法读取用量"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var creditsRow: some View {
        HStack(spacing: 10) {
            if let credits = account.usage?.credits {
                let balance = credits.unlimited ? "不限" : (credits.balance ?? "0")
                Text("充值余额 \(balance)")
                    .font(.caption2)
                    .foregroundStyle(credits.overageLimitReached ? .red : .secondary)
            }
            if let resetCredits = account.usage?.resetCredits {
                Text("重置卡 \(resetCredits.availableCount)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(isResetting ? "重置中…" : "使用重置卡", action: onRequestReset)
                    .font(.caption2)
                    .buttonStyle(.borderless)
                    .disabled(isResetting || resetCredits.applicableAvailableCount <= 0)
            }
        }
    }

    private func quotaRow(_ title: String, remaining: Double?, reset: TimeInterval?) -> some View {
        HStack(spacing: 8) {
            Text(title).font(.caption).frame(width: 42, alignment: .leading)
            ProgressView(value: remaining ?? 0, total: 100)
                .tint(color(for: remaining))
            Text(UsageFormatting.percent(remaining))
                .font(.caption.monospacedDigit().bold())
                .frame(width: 38, alignment: .trailing)
            Text(UsageFormatting.duration(reset))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 76, alignment: .trailing)
        }
    }

    private func color(for remaining: Double?) -> Color {
        guard let remaining else { return .gray }
        if remaining <= 10 { return .red }
        if remaining <= 35 { return .orange }
        return .green
    }
}
