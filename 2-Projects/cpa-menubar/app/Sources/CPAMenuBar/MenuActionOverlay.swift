import SwiftUI

struct MenuActionOverlay: View {
    @ObservedObject var model: AppModel
    @ObservedObject var presentation: MenuPresentation
    let overlay: MenuOverlay
    @FocusState private var cancelFocused: Bool
    @State private var contentHeight: CGFloat = 240

    var body: some View {
        GeometryReader { geometry in
          ZStack {
            Color.black.opacity(0.22)
                .contentShape(Rectangle())
                .onTapGesture { cancelFocused = true }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Label(title, systemImage: symbol)
                            .font(.headline)
                        Spacer()
                        Button {
                            presentation.handleEscape()
                        } label: {
                            Image(systemName: "xmark")
                                .frame(width: 24, height: 24)
                        }
                        .buttonStyle(.plain)
                        .focusable()
                        .accessibilityLabel(overlay.isAuthorization ? "收起授权窗口" : "取消确认")
                    }
                    content
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    GeometryReader { contentGeometry in
                        Color.clear.preference(key: DialogHeightKey.self, value: contentGeometry.size.height)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(width: min(350, geometry.size.width - 32), height: min(contentHeight, geometry.size.height - 32))
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Color.secondary.opacity(0.22))
            }
            .shadow(radius: 16, y: 8)
            .padding(16)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(title)
            .onPreferenceChange(DialogHeightKey.self) { height in
                contentHeight = height
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { cancelFocused = true }
        .onChange(of: presentation.focusRevision) { _, _ in cancelFocused = true }
    }

    private var title: String {
        switch overlay {
        case .subscriptions: "添加订阅"
        case .resetCredit: "使用 1 张重置卡？"
        case .removeAccount: "移除这个 CPA 账号？"
        case .clearToken: "清除本机 Token？"
        case .xaiAuthorization: "添加 xAI Grok 订阅"
        case .codexAuthorization: "Codex 授权进度"
        }
    }

    private var symbol: String {
        switch overlay {
        case .subscriptions: "person.badge.plus"
        case .resetCredit: "ticket"
        case .removeAccount: "person.crop.circle.badge.minus"
        case .clearToken: "key"
        case .xaiAuthorization, .codexAuthorization: "person.badge.key"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch overlay {
        case .subscriptions:
            Text("选择要添加到 CPA 的 OAuth 订阅账号。")
                .font(.callout).foregroundStyle(.secondary)
            Button {
                presentation.beginAuthorization(.codexAuthorization)
                model.addCodexAuthorization()
            } label: {
                providerLabel("Codex", detail: "ChatGPT 订阅授权")
            }
            .buttonStyle(.bordered)
            .focusable()
            Button {
                presentation.beginAuthorization(.xaiAuthorization)
                model.startXAIAuthorization()
            } label: {
                providerLabel("xAI Grok", detail: "订阅设备码授权")
            }
            .buttonStyle(.bordered)
            .focusable()
            HStack {
                Spacer()
                cancelButton
            }
        case let .resetCredit(account):
            Text(account.emailMasked).font(.subheadline.bold())
            Text("将尝试重置当前适用的额度窗口。Bridge 会在提交前重新确认仍有可用重置卡；成功后不可撤销。")
                .font(.callout).foregroundStyle(.secondary)
            if let count = account.usage?.resetCredits?.availableCount {
                Text("当前显示可用 \(count) 张").font(.caption.monospacedDigit())
            }
            HStack {
                Spacer()
                cancelButton
                Button("确认使用", role: .destructive) {
                    presentation.dismissOverlay()
                    Task { await model.consumeResetCredit(for: account) }
                }
                .buttonStyle(.borderedProminent).tint(.red)
                .focusable()
                .disabled(model.resettingAccountID != nil || (account.usage?.resetCredits?.availableCount ?? 0) <= 0)
            }
        case let .removeAccount(account):
            Text(account.emailMasked).font(.subheadline.bold())
            Text("账号会停止参与 CPA 调度，凭据文件进入可恢复隔离区。Bridge 会重新确认该账号是否符合移除条件。")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Spacer()
                cancelButton
                Button("确认移除", role: .destructive) {
                    presentation.dismissOverlay()
                    Task { await model.removeInvalidAccount(account) }
                }
                .buttonStyle(.borderedProminent).tint(.red)
                .focusable()
                .disabled(model.removingAccountID != nil || !account.removalEligible)
            }
        case .clearToken:
            Text("清除后应用将断开 CPA，重新连接需要再次输入 Desktop Token。不会删除服务器上的账号。")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Spacer()
                cancelButton
                Button("清除 Token", role: .destructive) {
                    presentation.dismissOverlay()
                    model.clearToken()
                }
                .buttonStyle(.borderedProminent).tint(.red)
                .focusable()
            }
        case .xaiAuthorization:
            xaiAuthorization
        case .codexAuthorization:
            if model.isAuthorizing {
                ProgressView(model.isCompletingCodexAuthorization ? "正在保存 Codex 授权…" : "请在浏览器中完成 Codex 授权")
                Text("关闭浏览器不会结束等待。可重新打开网页，或点击取消授权。收起窗口只隐藏界面。")
                    .font(.caption).foregroundStyle(.secondary)
                if let deadline = model.codexAuthorizationDeadline {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("剩余等待 \(max(0, Int(deadline.timeIntervalSince(context.date)))) 秒")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                Button("重新打开授权网页", action: model.openCodexAuthorizationPage)
                    .focusable()
                    .disabled(!model.canOpenCodexAuthorizationPage)
                HStack {
                    Button("取消授权") {
                        model.cancelCodexAuthorization()
                        presentation.dismissOverlay()
                    }
                    .focusable().focused($cancelFocused).keyboardShortcut(.defaultAction)
                    Spacer()
                    Button("暂时收起") { presentation.hide() }
                        .focusable()
                }
            } else {
                Text(model.errorMessage ?? model.statusMessage ?? "授权已结束")
                    .foregroundStyle(model.errorMessage == nil ? Color.primary : .red)
                HStack {
                    Button("完成") { presentation.dismissOverlay() }
                        .focusable().focused($cancelFocused).keyboardShortcut(.defaultAction)
                    Spacer()
                    if model.errorMessage != nil {
                        Button("重新授权", action: model.addCodexAuthorization)
                            .focusable()
                    }
                }
            }
        }
    }

    private var cancelButton: some View {
        Button("取消") { presentation.dismissOverlay() }
            .buttonStyle(.bordered)
            .focusable()
            .focused($cancelFocused)
            .keyboardShortcut(.defaultAction)
    }

    private func providerLabel(_ name: String, detail: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var xaiAuthorization: some View {
        if let session = model.xaiAuthorizationSession {
            Text("请在 xAI 官方页面输入设备码。切换到浏览器或收起本窗口不会取消授权。")
                .font(.callout).foregroundStyle(.secondary)
            VStack(spacing: 8) {
                Text(session.userCode)
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                Text(session.verificationURL.host ?? "accounts.x.ai")
                    .font(.caption).foregroundStyle(.secondary)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("剩余有效期 \(session.remainingSeconds(at: context.date)) 秒")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity)
            .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            Text(xaiStatusText(session)).font(.callout)
            HStack {
                Button("复制设备码", action: model.copyXAIDeviceCode)
                    .focusable()
                Button("打开授权网页", action: model.openXAIVerificationPage)
                    .focusable()
            }
            .buttonStyle(.bordered)
            HStack {
                Button(session.status.isTerminal ? "完成" : "取消授权") {
                    model.cancelXAIAuthorization()
                    presentation.dismissOverlay()
                }
                .focusable().focused($cancelFocused).keyboardShortcut(.defaultAction)
                Spacer()
                if session.status.isTerminal && session.status != .complete {
                    Button("重试", action: model.startXAIAuthorization)
                        .buttonStyle(.borderedProminent)
                        .focusable()
                } else {
                    Button("暂时收起") { presentation.hide() }
                        .focusable()
                }
            }
        } else if model.isStartingXAIAuthorization {
            ProgressView("正在启动 xAI 授权…")
            Button("取消授权") {
                model.cancelXAIAuthorization()
                presentation.dismissOverlay()
            }
            .focusable().focused($cancelFocused).keyboardShortcut(.defaultAction)
        } else {
            Text(model.errorMessage ?? "暂时无法启动 xAI 授权，请稍后重试。")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                cancelButton
                Spacer()
                Button("重试", action: model.startXAIAuthorization)
                    .buttonStyle(.borderedProminent)
                    .focusable()
            }
        }
    }

    private func xaiStatusText(_ session: XAIOAuthSession) -> String {
        if let message = session.message, !message.isEmpty { return message }
        return switch session.status {
        case .pending: "等待 xAI 授权"
        case .complete: "xAI 授权已完成"
        case .declined: "xAI 授权已取消"
        case .expired: "xAI 授权已过期"
        case .error: "xAI 授权失败"
        }
    }
}

private struct DialogHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
