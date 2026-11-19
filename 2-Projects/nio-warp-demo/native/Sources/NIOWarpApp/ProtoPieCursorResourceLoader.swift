import Foundation

/// A narrowly scoped fallback for public player artwork blocked by page CORS.
/// The URL must come from the bound page's computed cursor, never a guessed asset.
enum ProtoPieCursorResourceLoader {
    static let maximumBytes = 128 * 1024

    static func permittedURL(_ resource: String) -> URL? {
        guard let components = URLComponents(string: resource), components.scheme?.lowercased() == "https",
              components.host?.lowercased() == "static.protopie.io", components.user == nil,
              components.password == nil, components.port == nil || components.port == 443,
              !components.path.isEmpty, let url = components.url else { return nil }
        return url
    }

    static func load(_ url: URL) async throws -> Data {
        guard permittedURL(url.absoluteString) != nil else { throw failure() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 4
        configuration.connectionProxyDictionary = [:]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpShouldHandleCookies = false
        do {
            let (bytes, response) = try await session.bytes(for: request, delegate: ProtoPieCursorNoRedirectDelegate())
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.url == url, response.expectedContentLength <= maximumBytes else { throw failure() }
            var data = Data()
            for try await byte in bytes {
                guard data.count < maximumBytes else { throw failure() }
                data.append(byte)
            }
            guard !data.isEmpty else { throw failure() }
            return data
        } catch {
            // NSError can embed the entire request URL; callers receive only a
            // fixed explanation, never the original URL or browser credentials.
            throw failure()
        }
    }

    private static func failure() -> MouseInputTransportError {
        .unavailable("无法加载播放器原有鼠标资源，已保持普通输入。")
    }
}

private final class ProtoPieCursorNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
