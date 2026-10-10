import Foundation

/// A Connect browser link is independent of Cloud's restricted share links.
struct ProtoPieConnectSource: Equatable {
    struct PageIdentity: Equatable {
        let scheme: String
        let host: String
        let port: Int
        let path: String
        let pieID: Int
    }

    let url: URL
    let identity: PageIdentity

    static func parse(_ text: String) throws -> ProtoPieConnectSource {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              !host.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              !host.contains(where: { "/\\?#@".contains($0) }),
              components.user == nil, components.password == nil,
              components.percentEncodedPath == "/pie", validPort(in: text),
              let url = components.url, url.host != nil else {
            throw invalidLink()
        }
        let pieIDs = (components.queryItems ?? []).filter { $0.name == "pieid" }
        guard pieIDs.count == 1, let value = pieIDs[0].value, !value.isEmpty,
              value.utf8.allSatisfy({ (48...57).contains($0) }), let pieID = Int(value), pieID > 0 else {
            throw ProtoPieError.invalidSource("Connect 链接必须含唯一的正整数 pieid，请从 Connect 复制完整浏览器链接。")
        }
        return ProtoPieConnectSource(url: url, identity: PageIdentity(
            scheme: scheme, host: host.lowercased(), port: components.port ?? (scheme == "https" ? 443 : 80),
            path: components.percentEncodedPath, pieID: pieID))
    }

    /// Preserve encoded unknown query values: rebuilding them decoded would turn
    /// `%2B` into `+`, which browser URLSearchParams then reads as a space.
    func playbackURL(scaleToFit: Bool) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw Self.invalidLink() }
        var items = components.percentEncodedQueryItems ?? []
        items.removeAll { ["bg", "scaleToFit"].contains($0.name.removingPercentEncoding ?? $0.name) }
        var additions = URLComponents()
        additions.queryItems = [URLQueryItem(name: "bg", value: "#000000"),
                                URLQueryItem(name: "scaleToFit", value: scaleToFit ? "true" : "false")]
        items += additions.percentEncodedQueryItems ?? []
        components.percentEncodedQueryItems = items
        guard let result = components.url else { throw Self.invalidLink() }
        return result
    }

    static func pageIdentity(for url: URL) throws -> PageIdentity {
        try parse(url.absoluteString).identity
    }

    static func matchesPage(_ actual: URL, expected: URL) -> Bool {
        guard let actualIdentity = try? pageIdentity(for: actual),
              let expectedIdentity = try? pageIdentity(for: expected) else { return false }
        return actualIdentity == expectedIdentity
    }

    private static func validPort(in text: String) -> Bool {
        guard let separator = text.range(of: "://") else { return false }
        let authority = text[separator.upperBound...].prefix { !"/?#".contains($0) }
        let suffix: Substring
        if authority.hasPrefix("[") {
            guard let bracket = authority.firstIndex(of: "]") else { return false }
            suffix = authority[authority.index(after: bracket)...]
        } else if let colon = authority.firstIndex(of: ":") {
            suffix = authority[colon...]
        } else { return true }
        if suffix.isEmpty { return true }
        guard suffix.first == ":" else { return false }
        let digits = suffix.dropFirst()
        guard !digits.isEmpty, digits.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = Int(digits), (1...65_535).contains(port) else { return false }
        return true
    }

    private static func invalidLink() -> ProtoPieError {
        .invalidSource("请输入 Connect 复制的完整 http:// 或 https:// 浏览器链接（/pie?pieid=正整数）；不允许账号信息或无效端口。")
    }
}
