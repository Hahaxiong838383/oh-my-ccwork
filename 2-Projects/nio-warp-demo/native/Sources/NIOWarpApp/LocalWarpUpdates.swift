import Foundation

struct LocalWarpEditError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private final class LocalWarpJobToken {
    private let lock = NSLock()
    private var stopped = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func cancel() { lock.lock(); stopped = true; lock.unlock() }
}

final class LocalWarpUpdateCoordinator {
    private let queue = DispatchQueue(label: "com.mycc.nio-warp.local-mesh", qos: .userInitiated)
    private var pending: LocalWarpJobToken?
    private let delay: TimeInterval

    init(delay: TimeInterval = 0.025) { self.delay = delay }
    deinit { pending?.cancel() }

    func cancel() { pending?.cancel(); pending = nil }

    func submit(_ configuration: WarpConfiguration, completion: @escaping (Result<GeneratedMesh, LocalWarpEditError>) -> Void) {
        cancel()
        let token = LocalWarpJobToken()
        pending = token
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard !token.isCancelled else { return }
            let result: Result<GeneratedMesh, LocalWarpEditError>
            if let error = configuration.validationErrors().first {
                result = .failure(LocalWarpEditError(message: error))
            } else {
                let dimensions = WarpMath.meshDimensions(configuration: configuration)
                let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.columns, rows: dimensions.rows)
                result = mesh.validation.isValid ? .success(mesh) : .failure(LocalWarpEditError(message: mesh.validation.summary))
            }
            guard !token.isCancelled else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.pending === token, !token.isCancelled else { return }
                self.pending = nil
                completion(result)
            }
        }
    }
}
