import Foundation

/// Preserved v0.14.5 control path, selected explicitly for compatibility.
enum ProtoPieLegacyCDP {
    static func call(_ socket: URL, method: String, parameters: [String: Any] = [:]) async throws -> [String: Any] {
        try Task.checkCancellation()
        let data = try JSONSerialization.data(withJSONObject: ["id": 1, "method": method, "params": parameters])
        let task = URLSession.shared.webSocketTask(with: socket)
        task.resume()
        let deadline = Task { try? await Task.sleep(nanoseconds: 6_000_000_000); if !Task.isCancelled { task.cancel(with: .goingAway, reason: nil) } }
        defer { deadline.cancel(); task.cancel(with: .normalClosure, reason: nil) }
        return try await withTaskCancellationHandler(operation: {
            try await task.send(.string(String(decoding: data, as: UTF8.self)))
            while true {
                let message = try await task.receive()
                let bytes: Data
                switch message { case .data(let data): bytes = data; case .string(let string): bytes = Data(string.utf8); @unknown default: continue }
                guard let response = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], response["id"] as? Int == 1 else { continue }
                if let error = response["error"] as? [String: Any] {
                    throw ProtoPieError.unavailable("播放器控制失败：\(error["message"] as? String ?? method)")
                }
                return response["result"] as? [String: Any] ?? [:]
            }
        }, onCancel: { task.cancel(with: .goingAway, reason: nil) })
    }
}
