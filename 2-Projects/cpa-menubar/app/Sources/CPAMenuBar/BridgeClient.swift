import Foundation

struct BridgeClient: Sendable {
    let baseURL: URL
    let token: String
    let session: URLSession

    init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    func summary() async throws -> Summary {
        try await request(path: "summary")
    }

    func accounts() async throws -> AccountsResponse {
        try await request(path: "accounts")
    }

    func startOAuth() async throws -> OAuthStartResponse {
        try await request(path: "oauth/codex/start", method: "POST")
    }

    func completeOAuth(redirectURL: URL) async throws -> OAuthStatusResponse {
        try await request(
            path: "oauth/codex/callback",
            method: "POST",
            body: OAuthCallbackRequest(redirectURL: redirectURL.absoluteString)
        )
    }

    func startXAIOAuth() async throws -> XAIOAuthStartResponse {
        try await request(path: "oauth/xai/start", method: "POST")
    }

    func xaiOAuthStatus(state: String) async throws -> XAIOAuthStatusResponse {
        guard var components = URLComponents(
            url: baseURL.appending(path: "oauth/xai/status"),
            resolvingAgainstBaseURL: false
        ) else {
            throw BridgeClientError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "state", value: state)]
        guard let url = components.url else {
            throw BridgeClientError.invalidURL
        }
        return try await request(url: url)
    }

    func consumeResetCredit(accountID: String) async throws -> ResetCreditResponse {
        try await request(
            path: "accounts/\(accountID)/reset-credit",
            method: "POST",
            body: ResetCreditRequest()
        )
    }

    func removeInvalidAccount(accountID: String) async throws -> RemoveAccountResponse {
        try await request(
            path: "accounts/\(accountID)/remove",
            method: "POST",
            body: RemoveAccountRequest()
        )
    }

    private func request<Response: Decodable, Body: Encodable>(
        path: String,
        method: String = "GET",
        body: Body?
    ) async throws -> Response {
        try await request(url: baseURL.appending(path: path), method: method, body: body)
    }

    private func request<Response: Decodable, Body: Encodable>(
        url: URL,
        method: String = "GET",
        body: Body?
    ) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BridgeClientError.invalidResponse
        }
        guard 200..<300 ~= httpResponse.statusCode else {
            let message = (try? JSONDecoder().decode(BridgeErrorResponse.self, from: data).error) ?? "HTTP \(httpResponse.statusCode)"
            throw BridgeClientError.server(message)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func request<Response: Decodable>(path: String, method: String = "GET") async throws -> Response {
        try await request(path: path, method: method, body: Optional<EmptyBody>.none)
    }

    private func request<Response: Decodable>(url: URL, method: String = "GET") async throws -> Response {
        try await request(url: url, method: method, body: Optional<EmptyBody>.none)
    }
}

private struct EmptyBody: Encodable {}

enum BridgeClientError: LocalizedError {
    case invalidResponse
    case invalidURL
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Bridge 返回无效响应"
        case .invalidURL:
            return "Bridge 请求地址无效"
        case let .server(message):
            return message
        }
    }
}
