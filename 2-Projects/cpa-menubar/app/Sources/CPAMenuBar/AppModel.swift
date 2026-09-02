import AppKit
import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var summary: Summary?
    @Published var accounts: [Account] = []
    @Published var isRefreshing = false
    @Published var isAuthorizing = false
    @Published var isStartingXAIAuthorization = false
    @Published var xaiAuthorizationSession: XAIOAuthSession?
    @Published var resettingAccountID: String?
    @Published var removingAccountID: String?
    @Published var errorMessage: String?
    @Published var statusMessage: String?
    @Published var showSettings = false
    @Published var endpoint: String
    @Published var tokenInput = ""
    @Published var refreshMinutes: Double
    @Published var launchAtLogin = LoginItemController.isEnabled

    private let defaults = UserDefaults.standard
    private let oauthListener = OAuthCallbackListener()
    private var refreshTask: Task<Void, Never>?
    private var xaiAuthorizationTask: Task<Void, Never>?

    init() {
        endpoint = defaults.string(forKey: "bridgeEndpoint") ?? "https://smart-api.hahaxiong.top/desktop/v1"
        let storedMinutes = defaults.double(forKey: "refreshMinutes")
        refreshMinutes = storedMinutes > 0 ? storedMinutes : 5
        if defaults.object(forKey: "launchAtLoginConfigured") == nil {
            do {
                try LoginItemController.setEnabled(true)
                defaults.set(true, forKey: "launchAtLoginConfigured")
            } catch {
                statusMessage = "可在设置中开启开机启动"
            }
        }
        launchAtLogin = LoginItemController.isEnabled
        startAutoRefresh()
        Task { await refresh() }
    }

    deinit {
        refreshTask?.cancel()
        xaiAuthorizationTask?.cancel()
        oauthListener.stop()
    }

    var isConfigured: Bool {
        URL(string: endpoint) != nil && KeychainStore.loadToken()?.isEmpty == false
    }

    var minimumRemaining: Double? {
        accounts.compactMap { $0.usageSnapshot.weeklyRemainingPercent }.min()
    }

    var activeAPIKeyBudgets: [APIKeyBudget] {
        summary?.apiKeyBudgets?.filter(\.enabled) ?? []
    }

    var isAuthorizationActive: Bool {
        isAuthorizing || isStartingXAIAuthorization || xaiAuthorizationSession?.status == .pending
    }

    var primaryAPIKeyBudget: APIKeyBudget? {
        activeAPIKeyBudgets.min { left, right in
            switch (left.effectiveRemainingPercent, right.effectiveRemainingPercent) {
            case let (leftValue?, rightValue?):
                if leftValue != rightValue { return leftValue < rightValue }
                return (left.effectiveRemainingUSD ?? .greatestFiniteMagnitude) < (right.effectiveRemainingUSD ?? .greatestFiniteMagnitude)
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                return left.name < right.name
            }
        }
    }

    var displayedRemainingPercent: Double? {
        primaryAPIKeyBudget?.effectiveRemainingPercent ?? minimumRemaining
    }

    var menuLabel: String {
        guard isConfigured else { return "设置" }
        if let budget = primaryAPIKeyBudget, budget.usageStatus == "ok" {
            return UsageFormatting.compactUSD(budget.effectiveRemainingUSD)
        }
        guard let minimumRemaining else { return accounts.isEmpty ? "--" : "在线" }
        return UsageFormatting.percent(minimumRemaining)
    }

    var statusSymbol: String {
        if !isConfigured { return "gauge.with.dots.needle.0percent" }
        if errorMessage != nil { return "exclamationmark.triangle.fill" }
        guard let displayedRemainingPercent else { return "gauge.with.dots.needle.50percent" }
        if displayedRemainingPercent <= 10 { return "gauge.with.dots.needle.100percent" }
        if displayedRemainingPercent <= 35 { return "gauge.with.dots.needle.67percent" }
        return "gauge.with.dots.needle.33percent"
    }

    func saveSettings() {
        errorMessage = nil
        let trimmedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmedEndpoint),
              url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1"
        else {
            errorMessage = "Bridge 地址必须使用 HTTPS"
            return
        }
        endpoint = trimmedEndpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        defaults.set(endpoint, forKey: "bridgeEndpoint")
        refreshMinutes = min(60, max(1, refreshMinutes))
        defaults.set(refreshMinutes, forKey: "refreshMinutes")
        if !tokenInput.isEmpty {
            do {
                try KeychainStore.saveToken(tokenInput.trimmingCharacters(in: .whitespacesAndNewlines))
                tokenInput = ""
            } catch {
                errorMessage = error.localizedDescription
                return
            }
        }
        do {
            try LoginItemController.setEnabled(launchAtLogin)
        } catch {
            launchAtLogin = LoginItemController.isEnabled
            errorMessage = "开机启动设置失败：\(error.localizedDescription)"
        }
        startAutoRefresh()
        Task { await refresh() }
    }

    func clearToken() {
        do {
            try KeychainStore.deleteToken()
            summary = nil
            accounts = []
            statusMessage = "本机授权已清除"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func refresh() async -> Bool {
        guard !isRefreshing else { return false }
        guard let client = makeClient() else {
            showSettings = true
            return false
        }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            async let summaryRequest = client.summary()
            async let accountsRequest = client.accounts()
            let (newSummary, accountResponse) = try await (summaryRequest, accountsRequest)
            summary = newSummary
            accounts = accountResponse.accounts
            errorMessage = nil
            statusMessage = "更新于 \(Date().formatted(date: .omitted, time: .shortened))"
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func addCodexAuthorization() {
        guard !isAuthorizing else { return }
        guard let client = makeClient() else {
            showSettings = true
            return
        }
        isAuthorizing = true
        errorMessage = nil
        statusMessage = "正在等待浏览器授权"
        do {
            try oauthListener.start { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    switch result {
                    case let .success(callbackURL):
                        await self.completeOAuth(client: client, callbackURL: callbackURL)
                    case let .failure(error):
                        self.isAuthorizing = false
                        self.errorMessage = error.localizedDescription
                    }
                }
            }
        } catch {
            isAuthorizing = false
            errorMessage = "无法监听本机 1455 端口：\(error.localizedDescription)"
            return
        }
        Task {
            do {
                let response = try await client.startOAuth()
                NSWorkspace.shared.open(response.url)
            } catch {
                oauthListener.stop()
                isAuthorizing = false
                errorMessage = error.localizedDescription
            }
        }
    }

    func startXAIAuthorization() {
        guard !isAuthorizationActive else { return }
        guard let client = makeClient() else {
            showSettings = true
            return
        }
        cancelXAIAuthorization()
        isStartingXAIAuthorization = true
        errorMessage = nil
        statusMessage = "正在启动 xAI 授权"
        xaiAuthorizationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await client.startXAIOAuth()
                guard response.status == "pending",
                      !response.state.isEmpty,
                      !response.userCode.isEmpty,
                      response.expiresIn > 0,
                      XAIOAuthValidation.isAllowedVerificationURL(response.verificationURL)
                else {
                    throw XAIOAuthAppError.invalidStartResponse
                }
                let startedAt = Date()
                xaiAuthorizationSession = XAIOAuthSession(
                    state: response.state,
                    verificationURL: response.verificationURL,
                    userCode: response.userCode,
                    startedAt: startedAt,
                    expiresAt: startedAt.addingTimeInterval(TimeInterval(response.expiresIn)),
                    status: .pending,
                    message: nil
                )
                isStartingXAIAuthorization = false
                statusMessage = "请在 xAI 页面完成授权"
                if !NSWorkspace.shared.open(response.verificationURL) {
                    errorMessage = "无法打开 xAI 授权网页，请在授权窗口中重试"
                }
                await pollXAIAuthorization(client: client, state: response.state)
            } catch is CancellationError {
                isStartingXAIAuthorization = false
            } catch {
                isStartingXAIAuthorization = false
                xaiAuthorizationSession = nil
                errorMessage = error is XAIOAuthAppError ? error.localizedDescription : "xAI 授权启动失败，请稍后重试"
            }
        }
    }

    func cancelXAIAuthorization() {
        xaiAuthorizationTask?.cancel()
        xaiAuthorizationTask = nil
        isStartingXAIAuthorization = false
        xaiAuthorizationSession = nil
    }

    func openXAIVerificationPage() {
        guard let url = xaiAuthorizationSession?.verificationURL,
              XAIOAuthValidation.isAllowedVerificationURL(url)
        else {
            errorMessage = "xAI 授权地址无效"
            return
        }
        if !NSWorkspace.shared.open(url) {
            errorMessage = "无法打开 xAI 授权网页"
        }
    }

    func copyXAIDeviceCode() {
        guard let code = xaiAuthorizationSession?.userCode, !code.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if pasteboard.setString(code, forType: .string) {
            statusMessage = "xAI 设备码已复制"
        } else {
            errorMessage = "无法复制 xAI 设备码"
        }
    }

    func consumeResetCredit(for account: Account) async {
        guard resettingAccountID == nil else { return }
        guard let client = makeClient() else {
            showSettings = true
            return
        }
        resettingAccountID = account.id
        errorMessage = nil
        defer { resettingAccountID = nil }
        do {
            _ = try await client.consumeResetCredit(accountID: account.id)
            statusMessage = "已使用 1 张重置卡：\(account.emailMasked)"
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeInvalidAccount(_ account: Account) async {
        guard removingAccountID == nil else { return }
        guard account.removalEligible else {
            errorMessage = "账号当前不符合移除条件"
            return
        }
        guard let client = makeClient() else {
            showSettings = true
            return
        }
        removingAccountID = account.id
        errorMessage = nil
        defer { removingAccountID = nil }
        do {
            _ = try await client.removeInvalidAccount(accountID: account.id)
            statusMessage = "已移除账号：\(account.emailMasked)"
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func completeOAuth(client: BridgeClient, callbackURL: URL) async {
        defer { isAuthorizing = false }
        do {
            let response = try await client.completeOAuth(redirectURL: callbackURL)
            statusMessage = response.accountMasked.map { "已添加授权：\($0)" } ?? "授权已添加"
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pollXAIAuthorization(client: BridgeClient, state: String) async {
        while !Task.isCancelled {
            guard let session = xaiAuthorizationSession, session.state == state else { return }
            if session.remainingSeconds() == 0 {
                updateXAIAuthorization(status: .expired, message: "xAI 授权已过期")
                statusMessage = "xAI 授权已过期"
                return
            }
            do {
                try await Task.sleep(for: .seconds(2))
                let response = try await client.xaiOAuthStatus(state: state)
                guard response.state == state else {
                    throw XAIOAuthAppError.invalidStatusResponse
                }
                switch response.status {
                case "pending":
                    continue
                case "complete":
                    statusMessage = response.accountMasked.map { "已添加 xAI 订阅：\($0)" } ?? "xAI 订阅已添加"
                    xaiAuthorizationSession = nil
                    xaiAuthorizationTask = nil
                    if !(await refresh()) {
                        statusMessage = "授权已完成，账号刷新失败"
                    }
                    return
                case "declined":
                    updateXAIAuthorization(status: .declined, message: response.message ?? "xAI 授权已取消")
                    statusMessage = "xAI 授权已取消"
                    return
                case "expired":
                    updateXAIAuthorization(status: .expired, message: response.message ?? "xAI 授权已过期")
                    statusMessage = "xAI 授权已过期"
                    return
                case "error":
                    updateXAIAuthorization(status: .error, message: response.message ?? "xAI 授权失败")
                    statusMessage = "xAI 授权失败"
                    return
                default:
                    throw XAIOAuthAppError.invalidStatusResponse
                }
            } catch is CancellationError {
                return
            } catch {
                updateXAIAuthorization(status: .error, message: "xAI 授权状态检查失败")
                statusMessage = "xAI 授权状态检查失败"
                return
            }
        }
    }

    private func updateXAIAuthorization(status: XAIOAuthStatus, message: String?) {
        guard var session = xaiAuthorizationSession else { return }
        session.status = status
        session.message = message
        xaiAuthorizationSession = session
        xaiAuthorizationTask = nil
    }

    private func makeClient() -> BridgeClient? {
        guard let baseURL = URL(string: endpoint), let token = KeychainStore.loadToken(), !token.isEmpty else {
            return nil
        }
        return BridgeClient(baseURL: baseURL, token: token)
    }

    private func startAutoRefresh() {
        refreshTask?.cancel()
        let interval = UInt64(max(1, refreshMinutes) * 60 * 1_000_000_000)
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: interval)
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }
}

private enum XAIOAuthAppError: LocalizedError {
    case invalidStartResponse
    case invalidStatusResponse

    var errorDescription: String? {
        switch self {
        case .invalidStartResponse:
            return "Bridge 返回的 xAI 授权信息无效"
        case .invalidStatusResponse:
            return "Bridge 返回的 xAI 授权状态无效"
        }
    }
}
