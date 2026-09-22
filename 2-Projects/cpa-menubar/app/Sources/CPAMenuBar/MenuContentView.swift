import SwiftUI

private enum DashboardTab: String, CaseIterable, Identifiable {
    case overview
    case accounts
    case xai

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: "总览"
        case .accounts: "账号"
        case .xai: "xAI"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "rectangle.grid.2x2"
        case .accounts: "person.2"
        case .xai: "bolt.horizontal.circle"
        }
    }
}

struct MenuContentView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var presentation: MenuPresentation
    @State private var selectedTab: DashboardTab = .overview
    @State private var accountFilter: AccountListFilter = .all
    @State private var expandedAccountIDs: Set<String> = []

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                header
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                Divider()
                if model.showSettings || !model.isConfigured {
                    ScrollView {
                        settings.padding(16)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    tabPicker
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    Divider()
                    tabContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Divider()
                    footer
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                }
            }
            .disabled(presentation.overlay != nil)
            .allowsHitTesting(presentation.overlay == nil)
            .accessibilityHidden(presentation.overlay != nil)

            if let overlay = presentation.overlay {
                MenuActionOverlay(model: model, presentation: presentation, overlay: overlay)
                    .id(overlay.id)
                    .zIndex(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onExitCommand { presentation.handleEscape() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("CPA 状态")
                    .font(.headline)
                Text(model.statusMessage ?? "本机安全读取远端用量")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if model.isRefreshing {
                ProgressView().controlSize(.small)
            }
            Button {
                guard model.isConfigured else { return }
                model.showSettings.toggle()
            } label: {
                Image(systemName: model.showSettings || !model.isConfigured ? "xmark" : "gearshape")
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .disabled(!model.isConfigured)
            .help(model.isConfigured ? "连接设置" : "请先完成连接设置")
            Button { presentation.hide() } label: {
                Image(systemName: "xmark").frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .help("收起浮窗，保留授权进度")
            .accessibilityLabel("收起浮窗")
        }
    }

    private var tabPicker: some View {
        Picker("页面", selection: $selectedTab) {
            ForEach(DashboardTab.allCases) { tab in
                Label(tab.title, systemImage: tab.symbol)
                    .tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .overview:
            overview
        case .accounts:
            accounts
        case .xai:
            xaiDetails
        }
    }

    private var overview: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                serviceStatus
                overviewMetrics
                codexRuntimeOverview
                apiKeyBudgetOverview
                quotaOverview
                xaiOverview
                errorBanner
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var apiKeyBudgetOverview: some View {
        if let summary = model.summary, !model.activeAPIKeyBudgets.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("API Key 剩余额度", systemImage: "key.horizontal.fill")
                        .font(.subheadline.bold())
                    Spacer()
                    Text("日 / 周限制取较小值")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                ForEach(model.activeAPIKeyBudgets) { budget in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(budget.name.isEmpty ? budget.id : budget.name)
                                    .font(.caption.bold())
                                    .lineLimit(1)
                                Text("RPM \(budget.rpm) · \(budget.modelCount) 个模型")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(budget.usageStatus == "ok" ? UsageFormatting.usd(budget.effectiveRemainingUSD) : "--")
                                .font(.title3.monospacedDigit().bold())
                                .foregroundStyle(quotaColor(budget.effectiveRemainingPercent))
                        }

                        ProgressView(value: budget.effectiveRemainingPercent ?? 0, total: 100)
                            .tint(quotaColor(budget.effectiveRemainingPercent))

                        if budget.usageStatus == "ok" {
                            Text("日剩余 \(UsageFormatting.usdOrUnlimited(budget.dailyRemainingUSD, limit: budget.dailyLimitUSD)) · 周剩余 \(UsageFormatting.usdOrUnlimited(budget.weeklyRemainingUSD, limit: budget.weeklyLimitUSD))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(budget.usageError ?? summary.apiKeyBudgetError ?? "额度暂时无法计算")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }
                    if budget.id != model.activeAPIKeyBudgets.last?.id {
                        Divider()
                    }
                }
            }
            .cardStyle(tint: Color.green.opacity(0.08))
        } else if model.summary?.apiKeyBudgetStatus == "error" {
            Label(model.summary?.apiKeyBudgetError ?? "API Key 额度暂时不可用", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
                .cardStyle(tint: Color.orange.opacity(0.08))
        }
    }

    @ViewBuilder
    private var codexRuntimeOverview: some View {
        if let summary = model.summary {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label("Codex · 今日使用", systemImage: "waveform.path.ecg.rectangle")
                        .font(.subheadline.bold())
                    Spacer()
                    Text("CPA 原生统计")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let usage = summary.codexUsage, usage.requests > 0 {
                    HStack(spacing: 8) {
                        compactMetric("请求", value: UsageFormatting.integer(usage.requests))
                        compactMetric("Token", value: UsageFormatting.compactInteger(usage.totalTokens))
                        compactMetric("首字", value: UsageFormatting.milliseconds(usage.averageTTFTMS))
                        compactMetric("Fast 命中", value: UsageFormatting.percent(usage.fastActualPercent))
                    }

                    Text(runtimeSummaryLine(usage))
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    if usage.requests > usage.usageSamples {
                        Text("Token 覆盖率 \(UsageFormatting.percent(usage.usageCoveragePercent))，部分上游未返回完整 usage")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                } else if summary.codexUsageStatus == "error" {
                    Text(summary.codexUsageError ?? "CPA 请求统计暂时不可用")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else {
                    Text(summary.codexUsageStatus == "not_configured" ? "请求级统计尚未接入" : "正在采集今日请求数据")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .cardStyle(tint: Color.indigo.opacity(0.08))
        }
    }

    private var serviceStatus: some View {
        HStack(spacing: 8) {
            serviceBadge("CPA", healthy: model.summary?.services["cliproxy"])
            serviceBadge("Router", healthy: model.summary?.services["router"])
            Spacer()
            let refreshable = model.summary?.refreshableAccounts ?? model.accounts.filter(\.hasRefreshToken).count
            Label("\(refreshable) 个可刷新", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var overviewMetrics: some View {
        HStack(spacing: 8) {
            summaryMetric(
                "Codex",
                value: model.summary?.codexAccounts ?? AccountListPresentation.codexAccounts(from: model.accounts).count,
                symbol: "person.2.fill"
            )
            summaryMetric(
                "K12",
                value: model.summary?.k12Accounts ?? model.accounts.filter(\.isK12).count,
                symbol: "graduationcap.fill"
            )
            summaryMetric(
                "异常",
                value: attentionAccounts.count,
                symbol: attentionAccounts.isEmpty ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                tint: attentionAccounts.isEmpty ? .green : .orange
            )
        }
    }

    @ViewBuilder
    private var quotaOverview: some View {
        if let account = lowestQuotaAccount {
            let usage = account.usageSnapshot
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label("OAuth 最低周额度", systemImage: "gauge.with.dots.needle.67percent")
                        .font(.subheadline.bold())
                    Spacer()
                    Button("查看账号") { selectedTab = .accounts }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }

                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.emailMasked)
                            .font(.caption.bold())
                        Text(account.isK12 ? "K12" : (usage.planType ?? account.plan ?? "Codex").uppercased())
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(UsageFormatting.percent(usage.weeklyRemainingPercent))
                        .font(.title3.monospacedDigit().bold())
                        .foregroundStyle(quotaColor(usage.weeklyRemainingPercent))
                }

                ProgressView(value: usage.weeklyRemainingPercent ?? 0, total: 100)
                    .tint(quotaColor(usage.weeklyRemainingPercent))

                Text("距离重置 \(UsageFormatting.duration(usage.weeklyResetSeconds))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .cardStyle(tint: quotaColor(usage.weeklyRemainingPercent).opacity(0.08))
        } else {
            ContentUnavailableView("暂无周额度数据", systemImage: "gauge.with.dots.needle.0percent")
                .frame(maxWidth: .infinity, minHeight: 110)
        }
    }

    @ViewBuilder
    private var xaiOverview: some View {
        let xaiAccounts = model.accounts.filter { $0.provider.lowercased() == "xai" }
        let quotaPool = XAIQuotaPool(accounts: xaiAccounts)
        if let summary = model.summary, summary.xaiAccounts > 0 || summary.xaiUsage != nil {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label("xAI 摘要", systemImage: "bolt.horizontal.circle.fill")
                        .font(.subheadline.bold())
                    Spacer()
                    Button("查看详情") { selectedTab = .xai }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }

                if let usage = summary.xaiUsage {
                    HStack(spacing: 8) {
                        compactMetric("订阅池剩余", value: UsageFormatting.percent(quotaPool.averageRemainingPercent))
                        compactMetric("已同步", value: "\(quotaPool.measuredAccounts)/\(quotaPool.totalAccounts)")
                        compactMetric("24h Token", value: UsageFormatting.integer(usage.totalTokens))
                    }
                } else {
                    Text(summary.xaiUsageError ?? "暂时无法读取 xAI 用量")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .cardStyle(tint: Color.cyan.opacity(0.08))
        }
    }

    private var accounts: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Picker("账号筛选", selection: $accountFilter) {
                    ForEach(AccountListFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                Text("显示 \(filteredAccounts.count) / \(AccountListPresentation.codexAccounts(from: model.accounts).count) 个账号 · 异常与低额度优先")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if filteredAccounts.isEmpty {
                        ContentUnavailableView(
                            accountFilter == .attention ? "没有异常账号" : "没有符合条件的账号",
                            systemImage: accountFilter == .attention ? "checkmark.circle" : "person.crop.circle.badge.questionmark"
                        )
                        .frame(maxWidth: .infinity, minHeight: 180)
                    } else {
                        ForEach(filteredAccounts) { account in
                            AccountRow(
                                account: account,
                                isExpanded: expandedAccountIDs.contains(account.id),
                                isResetting: model.resettingAccountID == account.id,
                                isRemoving: model.removingAccountID == account.id,
                                onToggleExpanded: { toggleExpanded(account.id) },
                                onRequestReset: { presentation.present(.resetCredit(account)) },
                                onRequestRemoval: { presentation.present(.removeAccount(account)) }
                            )
                        }
                    }
                    errorBanner
                }
                .padding(16)
            }
        }
    }

    private var xaiDetails: some View {
        let xaiAccounts = model.accounts.filter { $0.provider.lowercased() == "xai" }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let summary = model.summary, summary.xaiAccounts > 0 || summary.xaiUsage != nil {
                    XAIUsageCard(
                        usage: summary.xaiUsage,
                        status: summary.xaiUsageStatus,
                        error: summary.xaiUsageError,
                        quotaPool: XAIQuotaPool(accounts: xaiAccounts)
                    )
                } else {
                    ContentUnavailableView("暂无 xAI 数据", systemImage: "bolt.horizontal.circle")
                        .frame(maxWidth: .infinity, minHeight: 180)
                }

                if !xaiAccounts.isEmpty {
                    HStack {
                        Label("xAI 订阅账号", systemImage: "person.2.fill")
                            .font(.subheadline.bold())
                        Spacer()
                        Text("\(xaiAccounts.count) 个")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }

                    ForEach(xaiAccounts) { account in
                        XAIAccountUsageCard(
                            account: account,
                            routeModelText: model.summary?.xaiUsage?.routeModelText,
                            isRemoving: model.removingAccountID == account.id,
                            onRequestRemoval: { presentation.present(.removeAccount(account)) }
                        )
                    }
                }
                errorBanner
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = model.errorMessage {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button {
                Task { await model.refresh() }
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .disabled(model.isRefreshing)

            Button {
                if model.xaiAuthorizationSession != nil || model.isStartingXAIAuthorization {
                    presentation.present(.xaiAuthorization)
                } else if model.isAuthorizing {
                    presentation.present(.codexAuthorization)
                } else {
                    presentation.present(.subscriptions)
                }
            } label: {
                Label(model.isAuthorizationActive || model.xaiAuthorizationSession != nil ? "继续授权" : "添加订阅", systemImage: "person.badge.plus")
            }

            Spacer()
            Text(AppRelease.label).font(.caption2).foregroundStyle(.secondary)
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
                        presentation.present(.clearToken)
                    }
                }
                Spacer()
                Button("退出") { NSApplication.shared.terminate(nil) }
            }
        }
    }

    private var filteredAccounts: [Account] {
        AccountListPresentation.filtered(model.accounts, by: accountFilter)
    }

    private var attentionAccounts: [Account] {
        AccountListPresentation.filtered(model.accounts, by: .attention)
    }

    private var lowestQuotaAccount: Account? {
        AccountListPresentation.codexAccounts(from: model.accounts)
            .filter { $0.usageSnapshot.weeklyRemainingPercent != nil }
            .min {
                ($0.usageSnapshot.weeklyRemainingPercent ?? 101) <
                    ($1.usageSnapshot.weeklyRemainingPercent ?? 101)
            }
    }

    private func toggleExpanded(_ accountID: String) {
        if expandedAccountIDs.contains(accountID) {
            expandedAccountIDs.remove(accountID)
        } else {
            expandedAccountIDs.insert(accountID)
        }
    }

    private func summaryMetric(_ title: String, value: Int, symbol: String, tint: Color = .accentColor) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: symbol)
                .font(.caption2)
                .foregroundStyle(tint)
            Text("\(value)")
                .font(.title3.monospacedDigit().bold())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    }

    private func compactMetric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit().bold())
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func serviceBadge(_ title: String, healthy: Bool?) -> some View {
        Label(title, systemImage: healthy == true ? "checkmark.circle.fill" : "xmark.circle.fill")
            .font(.caption.bold())
            .foregroundStyle(healthy == true ? .green : .red)
    }

    private func quotaColor(_ remaining: Double?) -> Color {
        guard let remaining else { return .gray }
        if remaining <= 10 { return .red }
        if remaining <= 35 { return .orange }
        return .green
    }

    private func runtimeSummaryLine(_ usage: RuntimeUsage) -> String {
        var parts = [
            "成功率 \(UsageFormatting.percent(usage.successPercent))",
            "平均延迟 \(UsageFormatting.milliseconds(usage.averageLatencyMS))",
            "推理 \(UsageFormatting.compactInteger(usage.reasoningTokens))",
            "缓存读取 \(UsageFormatting.compactInteger(usage.cacheReadTokens))"
        ]
        if usage.fastRequested > 0 {
            parts.append("Fast \(usage.fastActual)/\(usage.fastRequested)")
        }
        return parts.joined(separator: " · ")
    }
}

private struct XAIUsageCard: View {
    let usage: XAIUsage?
    let status: String?
    let error: String?
    let quotaPool: XAIQuotaPool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("xAI 订阅池", systemImage: "bolt.horizontal.circle.fill")
                .font(.subheadline.bold())

            subscriptionPool

            if let usage {
                Divider()
                compactOperations(usage)
            } else {
                Text(error ?? "暂时无法读取 xAI 用量")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if status == "unavailable", let error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        .cardStyle(tint: Color.cyan.opacity(0.08))
    }

    @ViewBuilder
    private var subscriptionPool: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("平均剩余")
                    .font(.caption.bold())
                Spacer()
                Text(UsageFormatting.percent(quotaPool.averageRemainingPercent))
                    .font(.title3.monospacedDigit().bold())
                    .foregroundStyle(quotaColor(quotaPool.averageRemainingPercent))
            }

            if let remaining = quotaPool.averageRemainingPercent {
                ProgressView(value: remaining, total: 100)
                    .tint(quotaColor(remaining))
                    .accessibilityLabel("xAI 订阅池平均剩余额度")
                    .accessibilityValue(UsageFormatting.percent(remaining))
            }

            HStack(spacing: 6) {
                Text("\(quotaPool.measuredAccounts)/\(quotaPool.totalAccounts) 个账号已同步")
                if let minimum = quotaPool.minimumRemainingPercent {
                    Text("· 最低 \(UsageFormatting.percent(minimum))")
                }
                if let reset = quotaPool.earliestResetAt {
                    Text("· 最近重置 \(UsageFormatting.dateTime(reset))")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            if quotaPool.inferredAccounts > 0 {
                Text("\(quotaPool.inferredAccounts) 个账号暂无计量，按 100% 剩余纳入等权平均")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func compactOperations(_ usage: XAIUsage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("账单与路由")
                    .font(.caption.bold())
                Spacer()
                Text("额度以上方订阅池为准")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                metric("API 本月", value: UsageFormatting.usd(usage.officialSpendUSD))
                metric("CPA 请求", value: UsageFormatting.integer(usage.requests))
                metric("24h Token", value: UsageFormatting.compactInteger(usage.totalTokens))
            }

            if usage.hasCPARouterUsage {
                Text("输入 \(UsageFormatting.integer(usage.inputTokens)) · 输出 \(UsageFormatting.integer(usage.outputTokens)) · 最近 \(UsageFormatting.timestamp(usage.lastRequestAt))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text(usage.cpaError ?? "CPA 暂时无法读取 xAI 路由统计")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func metric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit().bold())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func quotaColor(_ remaining: Double?) -> Color {
        guard let remaining else { return .secondary }
        if remaining <= 10 { return .red }
        if remaining <= 35 { return .orange }
        return .cyan
    }
}

private struct XAIAccountUsageCard: View {
    let account: Account
    let routeModelText: String?
    let isRemoving: Bool
    let onRequestRemoval: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.emailMasked)
                        .font(.subheadline.bold())
                        .lineLimit(1)
                    Text("xAI OAuth")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Label(statusText, systemImage: statusSymbol)
                    .font(.caption2)
                    .foregroundStyle(statusColor)
            }

            if !account.disabled {
                Text("Smart API 文本路由 \(routeModelText ?? "暂时无法读取")")
                    .font(.caption)
                    .foregroundStyle(routeModelText == nil ? Color.secondary : .blue)
                    .textSelection(.enabled)
                    .help("当前 Smart API 配置的上游文本模型；不代表 CPA Direct 请求或历史调用使用的模型。")
            }

            if let runtime = account.runtimeUsage, runtime.requests > 0 {
                HStack(spacing: 14) {
                    metric("今日请求", UsageFormatting.integer(runtime.requests))
                    metric("今日 Token", UsageFormatting.compactInteger(runtime.totalTokens))
                    metric("成功率", UsageFormatting.percent(runtime.successPercent))
                }

                Text("输入 \(UsageFormatting.integer(runtime.inputTokens)) · 输出 \(UsageFormatting.integer(runtime.outputTokens)) · 最近 \(UsageFormatting.timestamp(runtime.lastRequestAt))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                if let topModel = runtime.topModel, !topModel.isEmpty {
                    Text("今日最多请求 \(topModel)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help("今天请求中出现次数最多的模型标识，包含升级前记录；不是当前路由或上游实际响应型号。")
                }

                if runtime.errors > 0 {
                    Label(
                        runtime.lastErrorStatus.map { "今日 \(runtime.errors) 次错误 · 最近 HTTP \($0)" } ?? "今日 \(runtime.errors) 次错误",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption2)
                    .foregroundStyle(.orange)
                }
            } else {
                Text("今日暂无该账号的 CPA 请求记录")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Divider()

            xaiQuotaSection

            removalAction
        }
        .padding(10)
        .background(Color.cyan.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(account.disabled || !account.hasRefreshToken ? Color.orange.opacity(0.45) : Color.clear)
        }
    }

    @ViewBuilder
    private var xaiQuotaSection: some View {
        if let quota = account.xaiQuota, quota.status == "ok" {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label("官方周额度", systemImage: "gauge.with.dots.needle.50percent")
                        .font(.caption2.bold())
                    Spacer()
                    Text(UsageFormatting.percent(quota.remainingPercent))
                        .font(.caption2.monospacedDigit().bold())
                }
                if let remaining = quota.remainingPercent {
                    ProgressView(value: remaining, total: 100)
                        .tint(remaining <= 10 ? .red : (remaining <= 35 ? .orange : .cyan))
                        .accessibilityLabel("\(account.emailMasked) xAI 周剩余额度")
                        .accessibilityValue(UsageFormatting.percent(remaining))
                }
                HStack {
                    Text(quota.usageInferred ? "本周暂无计量，按 0% 已用显示" : "本周已用 \(UsageFormatting.percent(quota.usedPercent))")
                    Spacer()
                    if let reset = quota.periodEnd {
                        Text("重置 \(UsageFormatting.dateTime(reset))")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                if !quota.productUsage.isEmpty {
                    Text(quota.productUsage.map { "\(productName($0.product)) \(UsageFormatting.percent($0.usedPercent))" }.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let cap = quota.onDemandCapUSD, cap > 0 {
                    Text("额外用量 \(UsageFormatting.compactUSD(quota.onDemandUsedUSD)) / \(UsageFormatting.compactUSD(cap))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Text("额外用量未开启")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Text("来源 xAI CLI Billing · 更新 \(UsageFormatting.timestamp(quota.updatedAt))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else if let quota = account.xaiQuota {
            Label(xaiQuotaErrorText(quota.error), systemImage: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(.orange)
        } else {
            Text("xAI 订阅额度暂时无法读取")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func productName(_ value: String) -> String {
        switch value.lowercased() {
        case "grokbuild": return "Build"
        case "grokchat": return "Chat"
        case "grokimagine": return "Imagine"
        default: return value
        }
    }

    private func xaiQuotaErrorText(_ value: String?) -> String {
        switch value {
        case "authorization_required": return "订阅额度授权已失效，等待自动刷新"
        case "rate_limited": return "订阅额度接口暂时限流"
        default: return "订阅额度暂时无法读取"
        }
    }

    @ViewBuilder
    private var removalAction: some View {
        if account.removalEligible {
            Divider()
            HStack(spacing: 8) {
                if let reason = AccountListPresentation.removalReasonText(account.removalReason) {
                    Label(reason, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                Spacer()
                Button(isRemoving ? "移除中…" : "移除无效账号", role: .destructive, action: onRequestRemoval)
                    .font(.caption2)
                    .buttonStyle(.borderless)
                    .disabled(isRemoving)
            }
        }
    }

    private var statusText: String {
        if account.disabled { return "已停用" }
        if account.hasRefreshToken { return "可自动刷新" }
        return "需重新授权"
    }

    private var statusSymbol: String {
        if account.disabled { return "nosign" }
        if account.hasRefreshToken { return "checkmark.circle.fill" }
        return "exclamationmark.circle.fill"
    }

    private var statusColor: Color {
        if account.disabled { return .red }
        if account.hasRefreshToken { return .green }
        return .orange
    }

    private func metric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit().bold())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AccountRow: View {
    let account: Account
    let isExpanded: Bool
    let isResetting: Bool
    let isRemoving: Bool
    let onToggleExpanded: () -> Void
    let onRequestReset: () -> Void
    let onRequestRemoval: () -> Void

    var body: some View {
        let usage = account.usageSnapshot
        VStack(alignment: .leading, spacing: 9) {
            Button(action: onToggleExpanded) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.emailMasked)
                                .font(.subheadline.bold())
                                .lineLimit(1)
                            Text(account.isK12 ? "K12" : (usage.planType ?? account.plan ?? account.provider).uppercased())
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if account.hasRefreshToken {
                            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                                .foregroundStyle(.green)
                                .help("可自动刷新")
                        }
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                    }

                    if account.usageStatus == "ok" {
                        compactQuotaRow(remaining: usage.weeklyRemainingPercent, reset: usage.weeklyResetSeconds)
                    } else {
                        Label(
                            account.usageError ?? (account.disabled ? "账号已停用" : "暂时无法读取用量"),
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.caption)
                        .foregroundStyle(account.disabled ? .red : .orange)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider()

                HStack(spacing: 12) {
                    Label(account.hasRefreshToken ? "可自动刷新" : "需重新授权", systemImage: account.hasRefreshToken ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(account.hasRefreshToken ? .green : .orange)
                    if account.disabled {
                        Label("已停用", systemImage: "nosign")
                            .foregroundStyle(.red)
                    }
                }
                .font(.caption2)

                runtimeUsageDetails

                creditsRow

                removalAction
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(AccountListPresentation.needsAttention(account) ? Color.orange.opacity(0.45) : Color.clear)
        }
    }

    @ViewBuilder
    private var removalAction: some View {
        if account.removalEligible {
            HStack(spacing: 8) {
                if let reason = AccountListPresentation.removalReasonText(account.removalReason) {
                    Label(reason, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                Spacer()
                Button(isRemoving ? "移除中…" : "移除无效账号", role: .destructive, action: onRequestRemoval)
                    .font(.caption2)
                    .buttonStyle(.borderless)
                    .disabled(isRemoving)
            }
            .padding(8)
            .background(Color.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    @ViewBuilder
    private var runtimeUsageDetails: some View {
        if let runtime = account.runtimeUsage, runtime.requests > 0 {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 14) {
                    runtimeMetric("今日请求", UsageFormatting.integer(runtime.requests))
                    runtimeMetric("今日 Token", UsageFormatting.compactInteger(runtime.totalTokens))
                    runtimeMetric("首字", UsageFormatting.milliseconds(runtime.averageTTFTMS))
                }

                HStack(spacing: 14) {
                    runtimeMetric("Fast", runtime.fastRequested > 0 ? "\(runtime.fastActual)/\(runtime.fastRequested)" : "--")
                    runtimeMetric("成功率", UsageFormatting.percent(runtime.successPercent))
                    runtimeMetric("最后使用", UsageFormatting.timestamp(runtime.lastRequestAt))
                }

                if runtime.errors > 0 {
                    Label(
                        runtime.lastErrorStatus.map { "今日 \(runtime.errors) 次错误 · 最近 HTTP \($0)" } ?? "今日 \(runtime.errors) 次错误",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption2)
                    .foregroundStyle(.orange)
                }
            }
            .padding(8)
            .background(Color.indigo.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        } else {
            Text("今日暂无该账号的请求记录")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
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
                    .disabled(isResetting || resetCredits.availableCount <= 0)
            }
        }
    }

    private func compactQuotaRow(remaining: Double?, reset: TimeInterval?) -> some View {
        HStack(spacing: 8) {
            Text("每周")
                .font(.caption)
                .frame(width: 32, alignment: .leading)
            ProgressView(value: remaining ?? 0, total: 100)
                .tint(color(for: remaining))
            Text(UsageFormatting.percent(remaining))
                .font(.caption.monospacedDigit().bold())
                .frame(width: 38, alignment: .trailing)
            Text(UsageFormatting.duration(reset))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 72, alignment: .trailing)
        }
    }

    private func runtimeMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit().bold())
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func color(for remaining: Double?) -> Color {
        guard let remaining else { return .gray }
        if remaining <= 10 { return .red }
        if remaining <= 35 { return .orange }
        return .green
    }
}

private extension View {
    func cardStyle(tint: Color) -> some View {
        padding(12)
            .background(tint, in: RoundedRectangle(cornerRadius: 10))
    }
}
