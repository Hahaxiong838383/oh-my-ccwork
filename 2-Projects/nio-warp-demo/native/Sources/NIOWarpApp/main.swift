import AppKit
import Carbon
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Metal
import MetalKit
import ScreenCaptureKit

struct ShaderUniforms {
    var sourceAspect: Float
    var canvasAspect: Float
    var contentMode: Int32
    var mirrorFlags: UInt32
    var cropAnchor: SIMD2<Float>
    var sourceTexelSize: SIMD2<Float>
    var antiAliasingMode: UInt32
    var testPatternMode: UInt32
    var contentUVScale: SIMD2<Float>
    var gridUVScale: SIMD2<Float>
    var gridParameters: SIMD4<Float>
    var circleParameters: SIMD4<Float>
}

final class LatestFrameStore {
    private let lock = NSLock()
    private var frame: MouseCapturedFrame?
    private var lastRevocation: [String: Any]?

    func inputDiagnostic() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var result: [String: Any] = ["frameAvailable": frame != nil,
            "sourceAvailable": frame?.source != nil, "metadataAvailable": frame?.metadata != nil]
        result["lastRevocation"] = lastRevocation
        return result
    }

    func update(_ buffer: CVPixelBuffer, metadata: MouseCaptureMetadata? = nil, source: MouseCaptureSource? = nil) {
        lock.lock()
        frame = MouseCapturedFrame(pixelBuffer: buffer, metadata: metadata, source: source)
        lock.unlock()
    }

    func latest() -> CVPixelBuffer? {
        lock.lock()
        defer { lock.unlock() }
        return frame?.pixelBuffer
    }

    func snapshot() -> MouseCapturedFrame? {
        lock.lock(); defer { lock.unlock() }
        return frame
    }

    func revokeInput(reason: String = "revoked") {
        lock.lock(); defer { lock.unlock() }
        lastRevocation = ["reason": reason, "timestamp": Date().timeIntervalSince1970]
        if let frame { self.frame = MouseCapturedFrame(pixelBuffer: frame.pixelBuffer, metadata: nil, source: nil) }
    }

    func clear() {
        lock.lock()
        frame = nil
        lock.unlock()
    }
}

/// A candidate stream is probed independently so a failed replacement cannot
/// blank the current source or mistake an old stream's frame for readiness.
private final class CaptureFrameProbe: NSObject, SCStreamOutput {
    let frames = LatestFrameStore()
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue,
              let image = sampleBuffer.imageBuffer else { return }
        frames.update(image, metadata: MouseCaptureMetadata.read(sampleBuffer))
    }
}

private final class CaptureFrameRouter: @unchecked Sendable {
    let frameStore = LatestFrameStore()
    private let lock = NSLock()
    private var active: ObjectIdentifier?
    private var source: MouseCaptureSource?
    func activate(_ stream: SCStream?, source: MouseCaptureSource?) {
        lock.lock(); defer { lock.unlock() }
        active = stream.map(ObjectIdentifier.init)
        self.source = source
        if stream == nil { frameStore.clear() }
    }
    func owns(_ stream: SCStream) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active == ObjectIdentifier(stream)
    }
    func revokeInput(from stream: SCStream, reason: String = "revoked") {
        lock.lock(); defer { lock.unlock() }
        guard active == ObjectIdentifier(stream) else { return }
        frameStore.revokeInput(reason: reason)
    }
    func receive(_ buffer: CVPixelBuffer, metadata: MouseCaptureMetadata?, from stream: SCStream) {
        lock.lock(); defer { lock.unlock() }
        guard active == ObjectIdentifier(stream) else { return }
        frameStore.update(buffer, metadata: metadata, source: source)
    }
}

@MainActor private final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate {
    nonisolated private let routing = CaptureFrameRouter()
    nonisolated var frameStore: LatestFrameStore { routing.frameStore }
    private let queue = DispatchQueue(label: "com.mycc.nio-warp.capture", qos: .userInteractive)
    private var stream: SCStream?
    private var monitorTask: Task<Void, Never>?
    private var displayID: CGDirectDisplayID?
    private var displayPixelWidth = 0
    private var displayPixelHeight = 0
    private var sourceMode = CaptureSourceMode.entireDisplay
    private var minimumCoverage = 0.82
    private var currentWindowID: CGWindowID?
    private var pendingWindowID: CGWindowID?
    private var pendingWindowCount = 0
    private var missingWindowCount = 0
    private var pinnedWindowID: CGWindowID?
    private var pinning = false
    private var captureGeneration = UUID()
    var onError: ((String) -> Void)?
    var onNotice: ((String) -> Void)?
    var onPresentation: ((CapturePresentation) -> Void)?

    func start(
        displayID: CGDirectDisplayID,
        pixelWidth: Int,
        pixelHeight: Int,
        sourceMode: CaptureSourceMode,
        minimumCoverage: Double
    ) async throws {
        self.displayID = displayID
        displayPixelWidth = pixelWidth
        displayPixelHeight = pixelHeight
        self.sourceMode = sourceMode
        self.minimumCoverage = minimumCoverage
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        try Task.checkCancellation()
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw NSError(domain: "NIOWarp", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法找到源显示器"])
        }
        let filter = displayFilter(content: content, display: display)
        let configuration = streamConfiguration(width: pixelWidth, height: pixelHeight, singleWindow: false)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        markActiveStream(stream)
        try await stream.startCapture()
        try Task.checkCancellation()
        emitPresentation(
            sourceMode == .automaticFullscreenWindow
                ? .waitingForFullscreenWindow
                : .entireDisplay(width: pixelWidth, height: pixelHeight)
        )
        if sourceMode == .automaticFullscreenWindow { startMonitoring() }
    }

    private func markActiveStream(_ stream: SCStream?, source: MouseCaptureSource? = nil) {
        routing.activate(stream, source: source)
    }

    func stop() async {
        captureGeneration = UUID()
        pinnedWindowID = nil
        pinning = false
        markActiveStream(nil)
        monitorTask?.cancel()
        monitorTask = nil
        if let stream { try? await stream.stopCapture() }
        self.stream = nil
        frameStore.clear()
        currentWindowID = nil
        pendingWindowID = nil
        pendingWindowCount = 0
        missingWindowCount = 0
    }

    func updateSourceMode(_ sourceMode: CaptureSourceMode, minimumCoverage: Double) async throws {
        self.sourceMode = sourceMode
        self.minimumCoverage = minimumCoverage
        // Keep the user's ordinary-input preference without overriding an
        // explicitly bound ProtoPie preview session.
        guard pinnedWindowID == nil, !pinning else { return }
        pendingWindowID = nil
        pendingWindowCount = 0
        missingWindowCount = 0
        switch sourceMode {
        case .entireDisplay:
            monitorTask?.cancel()
            monitorTask = nil
            try await switchToDisplay(waitingForWindow: false)
        case .automaticFullscreenWindow:
            try await switchToDisplay(waitingForWindow: true)
            startMonitoring()
        }
    }

    func pinPreviewWindow(_ windowID: CGWindowID, processID: pid_t) async throws {
        guard stream != nil, displayID != nil else {
            throw NSError(domain: "NIOWarp", code: 31, userInfo: [NSLocalizedDescriptionKey: "等待外屏捕获启动后重试联动"])
        }
        let generation = UUID()
        captureGeneration = generation
        pinning = true
        let previousMonitor = monitorTask
        previousMonitor?.cancel()
        await previousMonitor?.value
        monitorTask = nil
        defer {
            if captureGeneration == generation {
                pinning = false
                if pinnedWindowID == nil, sourceMode == .automaticFullscreenWindow, stream != nil { startMonitoring() }
            }
        }
        try Task.checkCancellation()
        guard captureGeneration == generation else { throw CancellationError() }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        try Task.checkCancellation()
        guard let window = content.windows.first(where: { $0.windowID == windowID && $0.owningApplication?.processID == processID && $0.windowLayer == 0 }) else {
            throw NSError(domain: "NIOWarp", code: 32, userInfo: [NSLocalizedDescriptionKey: "指定 ProtoPie 预览窗口已关闭或不可捕获"])
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = max(Double(SCShareableContent.info(for: filter).pointPixelScale), 1)
        let width = max(Int((window.frame.width * scale).rounded()), 1)
        let height = max(Int((window.frame.height * scale).rounded()), 1)
        let probe = CaptureFrameProbe()
        // Chrome's native-fullscreen toolbar is a separate child window above
        // its webpage. Including it shrinks the capture and adds non-page pixels.
        let includeChildren = window.owningApplication?.bundleIdentifier != "com.google.Chrome"
        let candidate = SCStream(filter: filter, configuration: streamConfiguration(width: width, height: height, singleWindow: true, includeChildWindows: includeChildren), delegate: self)
        try candidate.addStreamOutput(probe, type: .screen, sampleHandlerQueue: queue)
        do {
            try await candidate.startCapture()
            for _ in 0..<60 {
                try Task.checkCancellation()
                guard captureGeneration == generation, stream != nil else { throw CancellationError() }
                if probe.frames.latest() != nil { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            try Task.checkCancellation()
            guard captureGeneration == generation, stream != nil, let firstFrame = probe.frames.snapshot() else {
                throw NSError(domain: "NIOWarp", code: 33, userInfo: [NSLocalizedDescriptionKey: "预览窗口未产生有效画面，保留上一捕获来源"])
            }
            let actualWidth = CVPixelBufferGetWidth(firstFrame.pixelBuffer)
            let actualHeight = CVPixelBufferGetHeight(firstFrame.pixelBuffer)
            if !includeChildren {
                guard actualWidth == width, actualHeight == height,
                      firstFrame.metadata?.coversTexture(width: width, height: height) == true else {
                    throw NSError(domain: "NIOWarp", code: 34, userInfo: [NSLocalizedDescriptionKey: "播放器捕获未覆盖完整窗口，暂不切换，避免显示被截断的内容"])
                }
                // No URL or captured pixels are persisted; this records the actual
                // accepted SCK surface rather than only the requested dimensions.
                let verification: [String: Any] = ["windowID": windowID,
                    "width": actualWidth, "height": actualHeight,
                    "fullWindowVerified": true, "timestamp": Date().timeIntervalSince1970]
                if let data = try? JSONSerialization.data(withJSONObject: verification, options: .sortedKeys) {
                    UserDefaults.standard.set(data, forKey: "nioWarpProtoPie.captureVerification.v1")
                }
            }
            try candidate.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            let previous = stream
            stream = candidate
            let inputSource = MouseCaptureSource(generation: generation, windowID: windowID, processID: processID,
                windowSize: window.frame.size, pointPixelScale: scale)
            markActiveStream(candidate, source: inputSource)
            frameStore.update(firstFrame.pixelBuffer, metadata: firstFrame.metadata, source: inputSource)
            pinnedWindowID = windowID
            currentWindowID = windowID
            monitorTask?.cancel()
            monitorTask = nil
            try? candidate.removeStreamOutput(probe, type: .screen)
            emitPresentation(.fullscreenWindow(applicationName: window.owningApplication?.applicationName ?? "ProtoPie", title: window.title ?? "预览", width: width, height: height))
            if let previous { try? await previous.stopCapture() }
        } catch {
            try? await candidate.stopCapture()
            throw error
        }
    }

    func releasePinnedPreview() async {
        captureGeneration = UUID()
        pinnedWindowID = nil
        pinning = false
        try? await updateSourceMode(sourceMode, minimumCoverage: minimumCoverage)
    }

    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? NSNumber,
              let status = SCFrameStatus(rawValue: raw.intValue) else { return }
        if status == .idle { return } // A static page retains the last completed frame.
        guard status == .complete, let imageBuffer = sampleBuffer.imageBuffer else {
            routing.revokeInput(from: stream, reason: "frame-status-\(status.rawValue)") // Keep visual last frame; revoke its input identity.
            return
        }
        routing.receive(imageBuffer, metadata: MouseCaptureMetadata.read(sampleBuffer), from: stream)
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        routing.revokeInput(from: stream, reason: "stream-error")
        Task { @MainActor [weak self] in
            guard let self, self.routing.owns(stream) else { return }
            self.emitError(error.localizedDescription)
        }
    }

    private func startMonitoring() {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.scanForFullscreenWindow()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    private func scanForFullscreenWindow() async {
        guard sourceMode == .automaticFullscreenWindow,
              pinnedWindowID == nil, !pinning,
              let displayID,
              stream != nil else { return }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard !Task.isCancelled, sourceMode == .automaticFullscreenWindow, pinnedWindowID == nil, !pinning, stream != nil else { return }
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return }
            let currentBundleID = Bundle.main.bundleIdentifier
            let eligibleWindows = content.windows.filter { window in
                guard window.windowLayer == 0,
                      window.owningApplication?.bundleIdentifier != currentBundleID,
                      window.owningApplication != nil,
                      window.isOnScreen || window.isActive else { return false }
                return window.frame.width >= 320 && window.frame.height >= 180
            }
            let descriptors = eligibleWindows.map { window in
                CaptureWindowDescriptor(
                    windowID: window.windowID,
                    frame: window.frame,
                    applicationName: window.owningApplication?.applicationName ?? "未知应用",
                    title: window.title ?? "",
                    isActive: window.isActive
                )
            }
            let candidate = AutomaticWindowSelector.bestCandidate(
                from: descriptors,
                displayFrame: display.frame,
                minimumCoverage: minimumCoverage
            )

            guard let candidate,
                  let window = eligibleWindows.first(where: { $0.windowID == candidate.descriptor.windowID }) else {
                pendingWindowID = nil
                pendingWindowCount = 0
                missingWindowCount += 1
                if currentWindowID != nil, missingWindowCount >= 2 {
                    try await switchToDisplay(content: content, display: display, waitingForWindow: true)
                }
                return
            }

            missingWindowCount = 0
            if currentWindowID == window.windowID {
                pendingWindowID = nil
                pendingWindowCount = 0
                return
            }
            if pendingWindowID == window.windowID {
                pendingWindowCount += 1
            } else {
                pendingWindowID = window.windowID
                pendingWindowCount = 1
            }
            guard pendingWindowCount >= 2 else { return }
            guard sourceMode == .automaticFullscreenWindow, pinnedWindowID == nil, !pinning else { return }
            try await switchToWindow(window)
        } catch {
            guard !Task.isCancelled else { return }
            emitNotice("自动跟随暂时不可用，已保留当前捕获：\(error.localizedDescription)")
        }
    }

    private func switchToDisplay(waitingForWindow: Bool) async throws {
        guard let displayID else { return }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return }
        try await switchToDisplay(content: content, display: display, waitingForWindow: waitingForWindow)
    }

    private func switchToDisplay(
        content: SCShareableContent,
        display: SCDisplay,
        waitingForWindow: Bool
    ) async throws {
        guard let stream else { return }
        let filter = displayFilter(content: content, display: display)
        let configuration = streamConfiguration(
            width: displayPixelWidth,
            height: displayPixelHeight,
            singleWindow: false
        )
        try await stream.updateConfiguration(configuration)
        try await stream.updateContentFilter(filter)
        currentWindowID = nil
        pendingWindowID = nil
        pendingWindowCount = 0
        missingWindowCount = 0
        emitPresentation(
            waitingForWindow
                ? .waitingForFullscreenWindow
                : .entireDisplay(width: displayPixelWidth, height: displayPixelHeight)
        )
    }

    private func switchToWindow(_ window: SCWindow) async throws {
        guard let stream else { return }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = max(Double(SCShareableContent.info(for: filter).pointPixelScale), 1)
        let width = max(Int((window.frame.width * scale).rounded()), 1)
        let height = max(Int((window.frame.height * scale).rounded()), 1)
        let configuration = streamConfiguration(width: width, height: height, singleWindow: true)
        try await stream.updateConfiguration(configuration)
        try await stream.updateContentFilter(filter)
        currentWindowID = window.windowID
        pendingWindowID = nil
        pendingWindowCount = 0
        missingWindowCount = 0
        emitPresentation(.fullscreenWindow(
            applicationName: window.owningApplication?.applicationName ?? "未知应用",
            title: window.title ?? "",
            width: width,
            height: height
        ))
    }

    private func displayFilter(content: SCShareableContent, display: SCDisplay) -> SCContentFilter {
        let currentBundleID = Bundle.main.bundleIdentifier
        let excludedApplications = content.applications.filter { application in
            application.bundleIdentifier == currentBundleID
        }
        return SCContentFilter(
            display: display,
            excludingApplications: excludedApplications,
            exceptingWindows: []
        )
    }

    private func streamConfiguration(width: Int, height: Int, singleWindow: Bool, includeChildWindows: Bool = true) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.captureResolution = .best
        configuration.ignoreShadowsSingleWindow = singleWindow
        configuration.ignoreGlobalClipSingleWindow = singleWindow
        if #available(macOS 14.2, *) {
            configuration.includeChildWindows = includeChildWindows
        }
        return configuration
    }

    private func emitPresentation(_ presentation: CapturePresentation) {
        NSLog("[NIOWarp Capture] %@", presentation.summary)
        UserDefaults.standard.set(presentation.summary, forKey: "nioWarpRuntimeCaptureSummary")
        UserDefaults.standard.set(Date(), forKey: "nioWarpRuntimeCaptureUpdatedAt")
        let callback = onPresentation
        DispatchQueue.main.async { callback?(presentation) }
    }

    private func emitError(_ message: String) {
        let callback = onError
        DispatchQueue.main.async { callback?(message) }
    }

    private func emitNotice(_ message: String) {
        let callback = onNotice
        DispatchQueue.main.async { callback?(message) }
    }
}

final class WarpRenderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private var textureCache: CVMetalTextureCache?
    private let frameStore: LatestFrameStore
    private var vertexBuffer: MTLBuffer?
    private var indexBuffer: MTLBuffer?
    private var indexCount = 0
    private var configuration: WarpConfiguration
    private let performanceMonitor = RollingPerformanceMonitor()
    var activeConfiguration: WarpConfiguration { configuration }
    private var runtimeAntiAliasingOverride: AntiAliasingMode?
    private(set) var meshValidation = MeshValidation(foldedCellCount: 0, outOfAASampleCount: 0, totalSampleCount: 0)
    private(set) var meshRevision = 0
    private(set) var currentMesh: GeneratedMesh?
    private(set) var inputFrame: MouseMappingRenderFrame?

    static let shaderSource = """
        #include <metal_stdlib>
        using namespace metal;

        struct VertexIn {
            float2 position [[attribute(0)]];
            float2 uv [[attribute(1)]];
        };

        struct VertexOut {
            float4 position [[position]];
            float2 uv;
        };

        struct Uniforms {
            float sourceAspect;
            float canvasAspect;
            int contentMode;
            uint mirrorFlags;
            float2 cropAnchor;
            float2 sourceTexelSize;
            uint antiAliasingMode;
            uint testPatternMode;
            float2 contentUVScale;
            float2 gridUVScale;
            float4 gridParameters;
            float4 circleParameters;
        };

        vertex VertexOut vertexMain(VertexIn input [[stage_in]]) {
            VertexOut output;
            output.position = float4(input.position, 0.0, 1.0);
            output.uv = input.uv;
            return output;
        }

        float gridLine(float coordinate, float spacing, float thickness, bool smoothEdges) {
            float repeated = abs(fract(coordinate / spacing + 0.5) - 0.5) * spacing;
            float width = max(fwidth(coordinate) * thickness, 0.00005);
            if (!smoothEdges) { return repeated <= width ? 1.0 : 0.0; }
            return 1.0 - smoothstep(width, width * 1.8, repeated);
        }

        float majorGridLine(float coordinate, float spacing, float widthPixels, bool smoothEdges) {
            float repeated = abs(fract(coordinate / spacing + 0.5) - 0.5) * spacing;
            float pixelStep = max(length(float2(dfdx(coordinate), dfdy(coordinate))), 0.00000001);
            float distancePixels = repeated / pixelStep;
            float halfWidth = widthPixels * 0.5;
            if (!smoothEdges) { return distancePixels <= halfWidth ? 1.0 : 0.0; }
            return 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, distancePixels);
        }

        float2 applyMirror(float2 uv, uint mirrorFlags) {
            if ((mirrorFlags & 1u) != 0u) { uv.x = 1.0 - uv.x; }
            if ((mirrorFlags & 2u) != 0u) { uv.y = 1.0 - uv.y; }
            return uv;
        }

        float rectangleMask(float2 uv, float2 minimum, float2 maximum, bool smoothEdges) {
            float2 edgeWidth = max(fwidth(uv) * 1.5, float2(0.00005));
            if (!smoothEdges) {
                float2 insideMinimum = step(minimum, uv);
                float2 insideMaximum = step(uv, maximum);
                return insideMinimum.x * insideMinimum.y * insideMaximum.x * insideMaximum.y;
            }
            float2 insideMinimum = smoothstep(minimum, minimum + edgeWidth, uv);
            float2 insideMaximum = 1.0 - smoothstep(maximum - edgeWidth, maximum, uv);
            return insideMinimum.x * insideMinimum.y * insideMaximum.x * insideMaximum.y;
        }

        float lineMask(float distance, float width, bool smoothEdges) {
            if (!smoothEdges) { return distance <= width ? 1.0 : 0.0; }
            return 1.0 - smoothstep(width, width * 2.5, distance);
        }

        float4 calibrationPattern(float2 uv, float2 gridScale, float4 parameters, float4 circleParameters, bool smoothEdges) {
            float2 gridUV = 0.5 + (uv - 0.5) * gridScale;
            float2 spacing = 1.0 / parameters.xy;
            float minorGrid = max(gridLine(gridUV.x, spacing.x / 5.0, 0.7, smoothEdges), gridLine(gridUV.y, spacing.y / 5.0, 0.7, smoothEdges));
            float majorGrid = max(majorGridLine(gridUV.x, spacing.x, parameters.z, smoothEdges), majorGridLine(gridUV.y, spacing.y, parameters.z, smoothEdges));
            float centerXWidth = max(fwidth(uv.x), 0.00005);
            float centerYWidth = max(fwidth(uv.y), 0.00005);
            float centerX = lineMask(abs(uv.x - 0.5), centerXWidth, smoothEdges);
            float centerY = lineMask(abs(uv.y - 0.5), centerYWidth, smoothEdges);
            float borderDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
            float borderWidth = max(fwidth(borderDistance), 0.00005);
            float border = lineMask(borderDistance, borderWidth, smoothEdges);
            float3 color = mix(float3(0.035), float3(0.20), minorGrid);
            color = mix(color, float3(0.85), majorGrid);
            color = mix(color, float3(1.0), border);

            // Three reference-canvas columns, repeated vertically beyond the original rows.
            // Pixel-space distance makes
            // the source markers circular even on an ultra-wide canvas. The mesh
            // still deforms them; derivatives adjust only the stroke width.
            float2 circleCell = floor(gridUV * 3.0);
            circleCell.x = clamp(circleCell.x, 0.0, 2.0);
            float2 circleCenter = (circleCell + 0.5) / 3.0;
            float signedCircleDistance = length((gridUV - circleCenter) * circleParameters.xy) - circleParameters.z;
            float circlePixelStep = max(length(float2(dfdx(signedCircleDistance), dfdy(signedCircleDistance))), 0.00000001);
            float circleDistancePixels = abs(signedCircleDistance) / circlePixelStep;
            float circleHalfWidth = parameters.z * 0.5;
            float circles = smoothEdges
                ? 1.0 - smoothstep(circleHalfWidth - 0.5, circleHalfWidth + 0.5, circleDistancePixels)
                : (circleDistancePixels <= circleHalfWidth ? 1.0 : 0.0);
            color = mix(color, float3(1.0, 0.72, 0.12), circles);
            color = mix(color, float3(1.0, 0.16, 0.10), centerX);
            color = mix(color, float3(0.15, 1.0, 0.28), centerY);

            float topLeft = rectangleMask(uv, float2(0.015, 0.015), float2(0.075, 0.075), smoothEdges);
            float topRight = rectangleMask(uv, float2(0.925, 0.015), float2(0.985, 0.075), smoothEdges);
            float bottomLeft = rectangleMask(uv, float2(0.015, 0.925), float2(0.075, 0.985), smoothEdges);
            float bottomRight = rectangleMask(uv, float2(0.925, 0.925), float2(0.985, 0.985), smoothEdges);
            color = mix(color, float3(1.0, 0.10, 0.85), topLeft);
            color = mix(color, float3(0.05, 0.85, 1.0), topRight);
            color = mix(color, float3(1.0, 0.85, 0.05), bottomLeft);
            color = mix(color, float3(1.0, 0.35, 0.05), bottomRight);
            return float4(color, 1.0);
        }

        float diagnosticLine(float distance, float width, bool smoothEdges) {
            if (!smoothEdges) { return distance <= width ? 1.0 : 0.0; }
            float transition = max(fwidth(distance) * 1.5, 0.00008);
            return 1.0 - smoothstep(width - transition, width + transition, distance);
        }

        float4 antiAliasingDiagnosticPattern(float2 uv, bool smoothEdges) {
            float2 centered = uv * 2.0 - 1.0;
            float diagonalA = diagnosticLine(abs(centered.y - centered.x * 0.62), 0.0022, smoothEdges);
            float diagonalB = diagnosticLine(abs(centered.y + centered.x * 0.37 - 0.18), 0.0012, smoothEdges);
            float radius = length(centered - float2(0.28, -0.06));
            float circle = diagnosticLine(abs(radius - 0.28), 0.0018, smoothEdges);
            float spokeAngle = atan2(centered.y + 0.12, centered.x + 0.35);
            float spokes = diagnosticLine(abs(sin(spokeAngle * 18.0)) * max(length(centered + float2(0.35, 0.12)), 0.05), 0.012, smoothEdges);
            float checker = fmod(floor(uv.x * 80.0) + floor(uv.y * 48.0), 2.0);
            float3 background = mix(float3(0.025), float3(0.12), checker * 0.45);
            float3 color = mix(background, float3(1.0), max(max(diagonalA, diagonalB), max(circle, spokes)));
            return float4(color, 1.0);
        }

        float4 sampleWarpedTexture(
            texture2d<float> source,
            sampler linearSampler,
            sampler pointSampler,
            float2 uv,
            constant Uniforms& uniforms) {
            if (uniforms.antiAliasingMode == 0u) {
                return source.sample(pointSampler, uv);
            }

            float2 derivativeX = dfdx(uv);
            float2 derivativeY = dfdy(uv);
            float2 footprint = max(abs(derivativeX), abs(derivativeY));
            float2 offset = max(footprint * 0.32, uniforms.sourceTexelSize * 0.35);
            float4 result = source.sample(linearSampler, clamp(uv + float2(-offset.x, -offset.y), 0.0, 1.0));
            result += source.sample(linearSampler, clamp(uv + float2(offset.x, -offset.y), 0.0, 1.0));
            result += source.sample(linearSampler, clamp(uv + float2(-offset.x, offset.y), 0.0, 1.0));
            result += source.sample(linearSampler, clamp(uv + float2(offset.x, offset.y), 0.0, 1.0));

            if (uniforms.antiAliasingMode == 1u) {
                return result * 0.25;
            }

            float4 center = source.sample(linearSampler, uv) * 2.0;
            float2 axisOffset = max(footprint * 0.48, uniforms.sourceTexelSize * 0.55);
            result += source.sample(linearSampler, clamp(uv + float2(axisOffset.x, 0.0), 0.0, 1.0));
            result += source.sample(linearSampler, clamp(uv - float2(axisOffset.x, 0.0), 0.0, 1.0));
            result += source.sample(linearSampler, clamp(uv + float2(0.0, axisOffset.y), 0.0, 1.0));
            result += source.sample(linearSampler, clamp(uv - float2(0.0, axisOffset.y), 0.0, 1.0));
            return (result + center) * 0.10;
        }

        fragment float4 fragmentMain(
            VertexOut input [[stage_in]],
            texture2d<float> source [[texture(0)]],
            constant Uniforms& uniforms [[buffer(1)]]) {
            constexpr sampler linearSampler(filter::linear, address::clamp_to_zero);
            constexpr sampler pointSampler(filter::nearest, address::clamp_to_zero);
            float2 uv = input.uv;

            float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
            float edgeWidth = max(fwidth(edgeDistance) * 1.25, 0.00001);
            float edgeAlpha = smoothstep(0.0, edgeWidth, edgeDistance);

            if (uniforms.testPatternMode == 1u) {
                float2 patternUV = applyMirror(uv, uniforms.mirrorFlags);
                bool smoothEdges = uniforms.antiAliasingMode != 0u;
                float4 pattern = calibrationPattern(patternUV, uniforms.gridUVScale, uniforms.gridParameters, uniforms.circleParameters, smoothEdges);
                return float4(pattern.rgb * edgeAlpha, 1.0);
            }

            if (uniforms.testPatternMode == 2u) {
                bool rightPanel = uv.x >= 0.5;
                float2 patternUV = float2(fract(uv.x * 2.0), uv.y);
                patternUV = applyMirror(patternUV, uniforms.mirrorFlags);
                bool smoothEdges = rightPanel && uniforms.antiAliasingMode != 0u;
                float4 pattern = antiAliasingDiagnosticPattern(patternUV, smoothEdges);
                float divider = diagnosticLine(abs(uv.x - 0.5), 0.0015, true);
                pattern.rgb = mix(pattern.rgb, float3(1.0, 0.18, 0.08), divider);
                return float4(pattern.rgb * edgeAlpha, 1.0);
            }

            uv = 0.5 + (uv - 0.5) * uniforms.contentUVScale;
            if (uniforms.contentMode == 0) {
                if (uniforms.sourceAspect < uniforms.canvasAspect) {
                    float visibleWidth = uniforms.sourceAspect / uniforms.canvasAspect;
                    uv.x = (uv.x - (1.0 - visibleWidth) * 0.5) / visibleWidth;
                } else {
                    float visibleHeight = uniforms.canvasAspect / uniforms.sourceAspect;
                    uv.y = (uv.y - (1.0 - visibleHeight) * 0.5) / visibleHeight;
                }
            } else if (uniforms.contentMode == 1) {
                if (uniforms.sourceAspect < uniforms.canvasAspect) {
                    float sampledHeight = uniforms.sourceAspect / uniforms.canvasAspect;
                    float start = (1.0 - sampledHeight) * (uniforms.cropAnchor.y + 1.0) * 0.5;
                    uv.y = uv.y * sampledHeight + start;
                } else {
                    float sampledWidth = uniforms.canvasAspect / uniforms.sourceAspect;
                    float start = (1.0 - sampledWidth) * (uniforms.cropAnchor.x + 1.0) * 0.5;
                    uv.x = uv.x * sampledWidth + start;
                }
            }

            uv = applyMirror(uv, uniforms.mirrorFlags);
            if (any(uv < 0.0) || any(uv > 1.0)) {
                return float4(0.0, 0.0, 0.0, 1.0);
            }
            float4 sampled = sampleWarpedTexture(source, linearSampler, pointSampler, uv, uniforms);
            return float4(sampled.rgb * edgeAlpha, 1.0);
        }
        """

    init?(view: MTKView, frameStore: LatestFrameStore, configuration: WarpConfiguration) {
        guard let device = MTLCreateSystemDefaultDevice(),
              let commandQueue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.commandQueue = commandQueue
        self.frameStore = frameStore
        self.configuration = configuration

        do {
            let library = try device.makeLibrary(source: Self.shaderSource, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "vertexMain")
            descriptor.fragmentFunction = library.makeFunction(name: "fragmentMain")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm

            let vertexDescriptor = MTLVertexDescriptor()
            vertexDescriptor.attributes[0].format = .float2
            vertexDescriptor.attributes[0].offset = 0
            vertexDescriptor.attributes[0].bufferIndex = 0
            vertexDescriptor.attributes[1].format = .float2
            vertexDescriptor.attributes[1].offset = MemoryLayout<SIMD2<Float>>.stride
            vertexDescriptor.attributes[1].bufferIndex = 0
            vertexDescriptor.layouts[0].stride = MemoryLayout<MeshVertex>.stride
            descriptor.vertexDescriptor = vertexDescriptor
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            return nil
        }

        super.init()
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColorMake(0, 0, 0, 1)
        view.preferredFramesPerSecond = 60
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        view.framebufferOnly = true
        CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
        rebuildMesh()
    }

    @discardableResult
    func updateConfiguration(_ configuration: WarpConfiguration) -> MeshValidation {
        guard configuration.validationErrors().isEmpty else {
            return MeshValidation(foldedCellCount: 0, outOfAASampleCount: 0, totalSampleCount: 0, nonFiniteSampleCount: 1)
        }
        let dimensions = WarpMath.meshDimensions(configuration: configuration)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.columns, rows: dimensions.rows)
        guard mesh.validation.isValid else { return mesh.validation }
        self.configuration = configuration
        runtimeAntiAliasingOverride = nil
        installMesh(mesh)
        return meshValidation
    }

    @discardableResult
    func updateCalibrationGrid(_ grid: CalibrationGridConfiguration) -> Bool {
        guard grid.isValid else { return false }
        configuration.render.calibrationGrid = grid
        return true
    }

    @discardableResult
    func installPreparedConfiguration(_ configuration: WarpConfiguration, mesh: GeneratedMesh) -> Bool {
        guard mesh.validation.isValid else { return false }
        self.configuration = configuration
        installMesh(mesh)
        return true
    }

    var effectiveAntiAliasingMode: AntiAliasingMode {
        guard configuration.render.antiAliasingEnabled else { return .off }
        return runtimeAntiAliasingOverride ?? configuration.render.antiAliasing
    }

    func performanceSnapshot() -> PerformanceSnapshot {
        performanceMonitor.snapshot(now: ProcessInfo.processInfo.systemUptime)
    }

    @discardableResult
    func evaluateAutomaticPerformanceFallback() -> Bool {
        guard configuration.render.antiAliasingEnabled,
              configuration.render.automaticPerformanceFallback,
              runtimeAntiAliasingOverride == nil else { return false }
        let snapshot = performanceSnapshot()
        guard PerformancePolicy.shouldFallback(
            snapshot: snapshot,
            antiAliasingEnabled: configuration.render.antiAliasingEnabled,
            currentMode: configuration.render.antiAliasing
        ) else { return false }
        runtimeAntiAliasingOverride = .performance
        return true
    }

    private func rebuildMesh() {
        let dimensions = WarpMath.meshDimensions(configuration: configuration)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.columns, rows: dimensions.rows)
        meshValidation = mesh.validation
        guard mesh.validation.isValid else { return }
        installMesh(mesh)
    }

    private func installMesh(_ mesh: GeneratedMesh) {
        currentMesh = mesh
        meshRevision += 1
        vertexBuffer = device.makeBuffer(
            bytes: mesh.vertices,
            length: mesh.vertices.count * MemoryLayout<MeshVertex>.stride
        )
        indexBuffer = device.makeBuffer(
            bytes: mesh.indices,
            length: mesh.indices.count * MemoryLayout<UInt32>.stride
        )
        indexCount = mesh.indices.count
        meshValidation = mesh.validation
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let frameTimestamp = ProcessInfo.processInfo.systemUptime
        performanceMonitor.recordFrame(at: frameTimestamp)
        guard let capturedFrame = frameStore.snapshot(),
              let descriptor = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor),
              let vertexBuffer,
              let indexBuffer,
              let textureCache else { return }

        let pixelBuffer = capturedFrame.pixelBuffer
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        var cvTexture: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault,
            textureCache,
            pixelBuffer,
            nil,
            .bgra8Unorm,
            width,
            height,
            0,
            &cvTexture
        )
        guard status == kCVReturnSuccess,
              let cvTexture,
              let texture = CVMetalTextureGetTexture(cvTexture) else { return }

        var mirrorFlags: UInt32 = 0
        if configuration.mirror.horizontal { mirrorFlags |= 1 }
        if configuration.mirror.vertical { mirrorFlags |= 2 }
        var uniforms = ShaderUniforms(
            sourceAspect: Float(width) / Float(height),
            canvasAspect: configuration.contentCanvas.aspect,
            contentMode: configuration.contentMode.shaderValue,
            mirrorFlags: mirrorFlags,
            cropAnchor: SIMD2<Float>(
                Float(configuration.cropAnchor.horizontal),
                Float(configuration.cropAnchor.vertical)
            ),
            sourceTexelSize: SIMD2<Float>(1 / Float(max(width, 1)), 1 / Float(max(height, 1))),
            antiAliasingMode: effectiveAntiAliasingMode.shaderValue,
            testPatternMode: configuration.render.testPattern.shaderValue,
            contentUVScale: configuration.contentUVScale,
            gridUVScale: configuration.gridUVScale,
            gridParameters: configuration.render.calibrationGrid.shaderParameters,
            circleParameters: configuration.calibrationCircleParameters
        )

        let aa = configuration.aaRect.sanitized()
        let drawableWidth = max(drawable.texture.width, 1)
        let drawableHeight = max(drawable.texture.height, 1)
        let scissorX = min(max(Int((aa.x * Double(drawableWidth)).rounded()), 0), drawableWidth - 1)
        let scissorY = min(max(Int((aa.y * Double(drawableHeight)).rounded()), 0), drawableHeight - 1)
        let scissorWidth = min(max(Int((aa.width * Double(drawableWidth)).rounded()), 1), drawableWidth - scissorX)
        let scissorHeight = min(max(Int((aa.height * Double(drawableHeight)).rounded()), 1), drawableHeight - scissorY)

        encoder.setRenderPipelineState(pipeline)
        encoder.setViewport(MTLViewport(
            originX: 0,
            originY: 0,
            width: Double(drawableWidth),
            height: Double(drawableHeight),
            znear: 0,
            zfar: 1
        ))
        encoder.setScissorRect(MTLScissorRect(x: scissorX, y: scissorY, width: scissorWidth, height: scissorHeight))
        encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<ShaderUniforms>.stride, index: 1)
        encoder.drawIndexedPrimitives(
            type: .triangle,
            indexCount: indexCount,
            indexType: .uint32,
            indexBuffer: indexBuffer,
            indexBufferOffset: 0
        )
        encoder.endEncoding()
        commandBuffer.present(drawable)
        let mappedFrame: MouseMappingRenderFrame?
        if let mesh = currentMesh, let source = capturedFrame.source, let metadata = capturedFrame.metadata {
            mappedFrame = MouseMappingRenderFrame(mesh: mesh, revision: meshRevision, configuration: configuration,
                sourceWidth: width, sourceHeight: height, source: source, metadata: metadata)
        } else { mappedFrame = nil }
        commandBuffer.addCompletedHandler { [weak self, performanceMonitor] completedBuffer in
            _ = cvTexture
            DispatchQueue.main.async {
                guard let self else { return }
                if completedBuffer.status == .completed, let mappedFrame, mappedFrame.revision == self.meshRevision,
                   mappedFrame.configuration == self.configuration, self.frameStore.snapshot()?.source == mappedFrame.source { self.inputFrame = mappedFrame }
                else { self.inputFrame = nil }
            }
            let gpuDuration = completedBuffer.gpuEndTime - completedBuffer.gpuStartTime
            performanceMonitor.recordGPUTime(
                seconds: gpuDuration,
                at: ProcessInfo.processInfo.systemUptime
            )
        }
        commandBuffer.commit()
    }
}

final class OutputWindow: NSWindow {
    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        isReleasedWhenClosed = false
    }

    var acceptsMappedInput = false
    override var canBecomeKey: Bool { acceptsMappedInput }
    override var canBecomeMain: Bool { false }
}

private final class AABoundaryOverlayView: NSView {
    private var aaRect = NormalizedRect.full
    private var isBoundaryVisible = false
    private let lineWidth: CGFloat = 3

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func update(aaRect: NormalizedRect, visible: Bool) {
        self.aaRect = aaRect.sanitized()
        isBoundaryVisible = visible
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard isBoundaryVisible else { return }
        let rect = AABoundaryOverlayGeometry.borderRect(
            in: bounds,
            aaRect: aaRect,
            lineWidth: lineWidth
        )
        NSColor.systemYellow.setStroke()
        let path = NSBezierPath(rect: rect)
        path.lineWidth = lineWidth
        path.stroke()
    }
}

private final class WarpBoundaryOverlayView: NSView {
    private var configuration: WarpConfiguration?
    private var isBoundaryVisible = false
    private let lineWidth: CGFloat = 3

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func update(configuration: WarpConfiguration, visible: Bool) {
        self.configuration = configuration
        isBoundaryVisible = visible
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard isBoundaryVisible, let configuration else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let clipRect = AABoundaryOverlayGeometry.borderRect(in: bounds, aaRect: configuration.aaRect, lineWidth: 0)
        NSBezierPath(rect: clipRect).addClip()
        let points = WarpBoundaryOverlayGeometry.points(in: bounds, configuration: configuration)
        guard let first = points.first else { return }
        NSColor.systemCyan.setStroke()
        let path = NSBezierPath()
        path.move(to: first)
        points.dropFirst().forEach { path.line(to: $0) }
        path.close()
        path.lineWidth = lineWidth
        path.stroke()
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private enum NumericFieldTarget: Int {
    case aaX
    case aaY
    case aaWidth
    case aaHeight
    case canvasWidth
    case canvasHeight
    case coefficientX
    case coefficientY
    case gridColumns
    case gridRows
    case gridLineWidth
    case outputVerticalOffset
}

private enum RuntimePreviewMode {
    case normal
    case rawReflectionCalibration
    case antiAliasingComparison
}

private enum AppVersion {
    static var display: String {
        let dictionary = Bundle.main.infoDictionary
        let version = dictionary?["CFBundleShortVersionString"] as? String ?? "开发版"
        let build = dictionary?["CFBundleVersion"] as? String ?? "-"
        return "v\(version) (\(build))"
    }
}

@MainActor private final class OutputController {
    let window: NSWindow
    let renderer: WarpRenderer
    private let aaBoundaryOverlay: AABoundaryOverlayView
    private let warpBoundaryOverlay: WarpBoundaryOverlayView
    let mouseCursor = MouseCursorOverlay()
    var onWillHide: (() -> Void)?

    init?(
        screen: NSScreen,
        pixelWidth: Int,
        pixelHeight: Int,
        frameStore: LatestFrameStore,
        configuration: WarpConfiguration
    ) {
        AppPresentationPolicy.ensureAccessoryPolicy()
        let window = OutputWindow(
            contentRect: NSRect(origin: .zero, size: screen.frame.size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        window.backgroundColor = .black
        window.isOpaque = true
        window.hasShadow = false
        window.collectionBehavior = OutputWindowBehavior.crossApplicationFullscreen
        window.level = .screenSaver
        window.ignoresMouseEvents = true
        window.hidesOnDeactivate = false

        let metalView = MTKView(frame: NSRect(origin: .zero, size: screen.frame.size))
        metalView.autoresizingMask = [.width, .height]
        metalView.autoResizeDrawable = false
        metalView.drawableSize = CGSize(width: pixelWidth, height: pixelHeight)
        guard let renderer = WarpRenderer(view: metalView, frameStore: frameStore, configuration: configuration) else { return nil }
        metalView.delegate = renderer
        let container = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        container.autoresizingMask = [.width, .height]
        container.addSubview(metalView)
        let aaBoundaryOverlay = AABoundaryOverlayView(frame: container.bounds)
        aaBoundaryOverlay.autoresizingMask = [.width, .height]
        aaBoundaryOverlay.update(
            aaRect: configuration.aaRect,
            visible: configuration.render.showAABoundary
        )
        container.addSubview(aaBoundaryOverlay)
        let warpBoundaryOverlay = WarpBoundaryOverlayView(frame: container.bounds)
        warpBoundaryOverlay.autoresizingMask = [.width, .height]
        warpBoundaryOverlay.update(
            configuration: configuration,
            visible: configuration.render.showWarpBoundary
        )
        container.addSubview(warpBoundaryOverlay)
        mouseCursor.frame = container.bounds
        mouseCursor.autoresizingMask = [.width, .height]
        mouseCursor.physicalSize = SIMD2(Float(pixelWidth), Float(pixelHeight))
        container.addSubview(mouseCursor)
        window.contentView = container
        window.setFrame(screen.frame, display: true)
        window.orderFrontRegardless()

        self.window = window
        self.renderer = renderer
        self.aaBoundaryOverlay = aaBoundaryOverlay
        self.warpBoundaryOverlay = warpBoundaryOverlay
    }

    var isWarpVisible: Bool { window.isVisible }

    func setWarpVisible(_ visible: Bool) {
        if visible {
            restorePresentation()
        } else {
            onWillHide?()
            window.orderOut(nil)
        }
        publishPresentationDiagnostic()
    }

    func restorePresentation() {
        AppPresentationPolicy.ensureAccessoryPolicy()
        window.orderFrontRegardless()
        publishPresentationDiagnostic()
    }

    func publishPresentationDiagnostic() {
        // isVisible describes our requested visibility, not whether macOS has
        // composited this window into another application's fullscreen Space.
        UserDefaults.standard.set([
            "updatedAt": Date().timeIntervalSince1970,
            "activationPolicy": NSApp.activationPolicy().rawValue,
            "windowNumber": window.windowNumber,
            "requestedVisible": window.isVisible,
            "onActiveSpace": window.isOnActiveSpace,
            "occlusionVisible": window.occlusionState.contains(.visible),
            "frame": NSStringFromRect(window.frame)
        ], forKey: "nioWarpOutputPresentation.runtime.v1")
    }

    func setMouseInputEnabled(_ enabled: Bool) {
        (window as? OutputWindow)?.acceptsMappedInput = enabled
        window.ignoresMouseEvents = !enabled
        mouseCursor.receivesInput = enabled
        if enabled { window.makeFirstResponder(mouseCursor) }
    }

    func updateAABoundary(aaRect: NormalizedRect, visible: Bool) {
        aaBoundaryOverlay.update(aaRect: aaRect, visible: visible)
    }

    func updateWarpBoundary(configuration: WarpConfiguration, visible: Bool) {
        warpBoundaryOverlay.update(configuration: configuration, visible: visible)
    }
}

private final class WorkbenchWindow: NSWindow {
    var onModuleShortcut: ((Int) -> Void)?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection([.command, .control, .option]) == .command,
           let number = Int(event.charactersIgnoringModifiers ?? ""), (1...7).contains(number) {
            onModuleShortcut?(number - 1)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class ControlPanelController: NSWindowController, NSTextFieldDelegate, NSTabViewDelegate, NSWindowDelegate, NSSplitViewDelegate {
    private let renderer: WarpRenderer?
    private let store: ConfigurationStore
    private let presetStore: PresetStore
    private let historyStore: ConfigurationHistoryStore
    private let displayWidth: Int
    private let displayHeight: Int
    private let setWarpVisible: (Bool) -> Void
    private let isWarpVisible: () -> Bool
    private let applyCaptureConfiguration: (CaptureConfiguration) -> Void
    private let updateAABoundary: (NormalizedRect, Bool) -> Void
    private let updateWarpBoundary: (WarpConfiguration, Bool) -> Void
    private var configuration: WarpConfiguration
    private var lastAppliedConfiguration: WarpConfiguration
    private var performanceTimer: Timer?
    private var presets = [WarpPreset]()
    private var runtimePreviewMode = RuntimePreviewMode.normal
    private var runtimePreviewReturnMode = RuntimePreviewMode.normal
    private var captureSourceWidth: Int
    private var captureSourceHeight: Int
    private var gridHistoryRecorded = false
    private var gridHistoryReset: DispatchWorkItem?
    private let localUpdates = LocalWarpUpdateCoordinator()
    private var localHistoryBaseline: WarpConfiguration?
    private(set) var localEditor: LocalWarpEditorController?
    private(set) var bezierEditor: BezierWarpEditorController?
    private let bezierUpdates = LocalWarpUpdateCoordinator()
    private var bezierHistoryBaseline: WarpConfiguration?
    private var geometryValidationInFlight = false
    private var geometryValidationSource: String?
    private var renderedFieldValues: [ObjectIdentifier: String] = [:]
    private var draftFields: [NSTextField] { [aaXField, aaYField, aaWidthField, aaHeightField, canvasWidthField, canvasHeightField, coefficientXField, coefficientYField, outputVerticalOffsetField] }
    private let snapTiltButton = NSButton(checkboxWithTitle: "倾斜零点吸附", target: nil, action: nil)
    private let snapBendButton = NSButton(checkboxWithTitle: "水平弯曲零点吸附", target: nil, action: nil)
    private let centerSurfaceXButton = NSButton(checkboxWithTitle: "画面水平居中", target: nil, action: nil)
    private let centerSurfaceYButton = NSButton(checkboxWithTitle: "画面垂直居中", target: nil, action: nil)
    private let levelSurfaceButton = NSButton(checkboxWithTitle: "参考轴居正", target: nil, action: nil)

    private let statusLabel = NSTextField(wrappingLabelWithString: "等待屏幕捕获权限…")
    private let globalStatusLabel = NSTextField(wrappingLabelWithString: "正在准备控制台…")
    private let configurationTabs = NSTabView()
    static let modules = [("canvas", "画布与输入"), ("global", "整体校正"), ("local", "局部微调"), ("quality", "标定与画质"), ("history", "预设与历史"), ("mouse", "鼠标映射"), ("protopie", "ProtoPie 联动")]
    private let modulePicker = NSSegmentedControl()
    private let localToolPicker = NSSegmentedControl(labels: ["贝塞尔曲面", "交点精调"], trackingMode: .selectOne, target: nil, action: nil)
    private let previewHost = NSView()
    private let standardPreview = NSView()
    private let localInspectorHost = NSView()
    private let polynomialDetails = NSStackView()
    private let polynomialDisclosure = NSButton(checkboxWithTitle: "高级：展开多项式增量", target: nil, action: nil)
    private let previewColumn = NSStackView()
    private let layerSummary = NSTextField(wrappingLabelWithString: "")
    private let pinButton = NSButton(checkboxWithTitle: "保持置顶", target: nil, action: nil)
    private var quitConfirmation: NSAlert?
    private let terminateApplication: () -> Void
    private var selectedLocalTool = 0
    private var builtInterface = false
    private let protoPie: ProtoPieCoordinator?
    private var protoPiePanel: ProtoPiePanel?
    private let playback: ProtoPiePlaybackController?
    private var playbackPanel: ProtoPiePlaybackPanel?
    private var standardBody: NSView?
    private var playbackHost: NSTabView?
    private var playbackWorkspace: NSView?
    private var playbackSectionPicker: NSSegmentedControl?
    private let mouseMapping: MouseMappingController?
    private var mouseMappingPanel: MouseMappingPanel?
    private var inspectorWidthConstraint: NSLayoutConstraint?
    private let preferredControlDisplayID: CGDirectDisplayID?
    var selectedModuleIdentifier: String { configurationTabs.selectedTabViewItem?.identifier as? String ?? "canvas" }
    private var tabPageDocuments = [NSView]()
    private let captureSourcePicker = NSPopUpButton()
    private let capturePresentationLabel = NSTextField(wrappingLabelWithString: "当前捕获：初始化中…")
    private let aaXField = NSTextField()
    private let aaYField = NSTextField()
    private let aaWidthField = NSTextField()
    private let aaHeightField = NSTextField()
    private let aaBoundaryButton = NSButton(checkboxWithTitle: "显示黄色线：外屏允许显示的范围", target: nil, action: nil)
    private let extendedWarpButton = NSButton(checkboxWithTitle: "让画布沿当前曲线向外延伸", target: nil, action: nil)
    private let warpBoundaryButton = NSButton(checkboxWithTitle: "显示青色线：弯曲画布的外边缘", target: nil, action: nil)
    private let canvasReferenceLabel = NSTextField(wrappingLabelWithString: "尚未记住外扩起点")
    private let canvasMeasurementLabel = NSTextField(wrappingLabelWithString: "")
    private let geometryPreview = CanvasGeometryPreviewView()
    private let geometryPreviewPicker = NSPopUpButton()
    private let canvasWidthField = NSTextField()
    private let canvasHeightField = NSTextField()
    private let cropHorizontalSlider = NSSlider()
    private let cropVerticalSlider = NSSlider()
    private let outputVerticalOffsetSlider = NSSlider()
    private let outputVerticalOffsetField = NSTextField()
    private let contentMappingLabel = NSTextField(wrappingLabelWithString: "内容映射计算中…")
    private let horizontalMirrorButton = NSButton(checkboxWithTitle: "水平翻转", target: nil, action: nil)
    private let verticalMirrorButton = NSButton(checkboxWithTitle: "垂直翻转", target: nil, action: nil)
    private let warpButton = NSButton(checkboxWithTitle: "使用下方滑杆调整画面弯曲", target: nil, action: nil)
    private let inverseWarpTrendButton = NSButton(checkboxWithTitle: "反向预畸变趋势（屏幕中凹两侧翘）", target: nil, action: nil)
    private let polynomialButton = NSButton(checkboxWithTitle: "在基础校正上叠加多项式微调", target: nil, action: nil)
    private let orderPicker = NSPopUpButton()
    private let termPicker = NSPopUpButton()
    private let coefficientXField = NSTextField()
    private let coefficientYField = NSTextField()
    private let contentModePicker = NSPopUpButton()
    private let strengthSlider = NSSlider()
    private let archSlider = NSSlider()
    private let verticalScaleSlider = NSSlider()
    private let verticalScaleReadout = NSTextField(labelWithString: "1.00×")
    private let asymmetrySlider = NSSlider()
    private let tiltSlider = NSSlider()
    private let horizontalBendSlider = NSSlider()
    private let antiAliasingPicker = NSPopUpButton()
    private let antiAliasingEnabledButton = NSButton(checkboxWithTitle: "平滑线条边缘（抗锯齿）", target: nil, action: nil)
    private let automaticPerformanceButton = NSButton(checkboxWithTitle: "帧率不足时，自动降低采样档位保流畅", target: nil, action: nil)
    private let testPatternButton = NSButton(checkboxWithTitle: "显示标定网格、纵向重复圆、中心线和边界", target: nil, action: nil)
    private let gridColumnsField = NSTextField()
    private let gridRowsField = NSTextField()
    private let gridLineWidthField = NSTextField()
    private let gridSummaryLabel = NSTextField(wrappingLabelWithString: "")
    private let gridStatusLabel = NSTextField(wrappingLabelWithString: "")
    private let rawCalibrationButton = NSButton(title: "一键无畸变标定", target: nil, action: nil)
    private let antiAliasingComparisonButton = NSButton(title: "抗锯齿 A/B 对比", target: nil, action: nil)
    private let performanceLabel = NSTextField(wrappingLabelWithString: "性能采样中…")
    private let pauseWarpButton = NSButton(title: "暂时显示原始桌面", target: nil, action: nil)
    private let presetNameField = NSTextField()
    private let presetPicker = NSPopUpButton()
    private let historyButton = NSButton(title: "撤销上一次设置", target: nil, action: nil)

    var isWaitingForDisplay: Bool { renderer == nil }
    var configurationForOfflinePreview: WarpConfiguration { lastAppliedConfiguration }

    init(
        renderer: WarpRenderer?,
        store: ConfigurationStore,
        configuration: WarpConfiguration,
        sourceScreen: NSScreen?,
        outputScreen: NSScreen?,
        setWarpVisible: @escaping (Bool) -> Void,
        isWarpVisible: @escaping () -> Bool,
        applyCaptureConfiguration: @escaping (CaptureConfiguration) -> Void,
        updateAABoundary: @escaping (NormalizedRect, Bool) -> Void,
        updateWarpBoundary: @escaping (WarpConfiguration, Bool) -> Void,
        presentWindow: Bool = true,
        historyStore: ConfigurationHistoryStore = ConfigurationHistoryStore(),
        presetStore: PresetStore = PresetStore(),
        protoPie: ProtoPieCoordinator? = nil,
        mouseMapping: MouseMappingController? = nil,
        playback: ProtoPiePlaybackController? = nil,
        terminateApplication: @escaping () -> Void = { NSApplication.shared.terminate(nil) }
    ) {
        self.renderer = renderer
        self.store = store
        self.historyStore = historyStore
        self.presetStore = presetStore
        self.protoPie = protoPie
        self.mouseMapping = mouseMapping
        self.playback = playback
        preferredControlDisplayID = (sourceScreen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        self.terminateApplication = terminateApplication
        self.configuration = configuration
        lastAppliedConfiguration = configuration
        self.setWarpVisible = setWarpVisible
        self.isWarpVisible = isWarpVisible
        self.applyCaptureConfiguration = applyCaptureConfiguration
        self.updateAABoundary = updateAABoundary
        self.updateWarpBoundary = updateWarpBoundary
        displayWidth = configuration.displayPixelWidth
        displayHeight = configuration.displayPixelHeight
        captureSourceWidth = configuration.displayPixelWidth
        captureSourceHeight = configuration.displayPixelHeight
        let panel = WorkbenchWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "NIO Warp 工作台 · \(AppVersion.display)"
        if renderer == nil { panel.title += " · 等待外屏" }
        panel.level = .normal
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentMinSize = WorkbenchWindowPlacement.preferredMinimumContentSize
        super.init(window: panel)
        panel.onModuleShortcut = { [weak self] index in self?.selectModule(Self.modules[index].0) }
        panel.delegate = self
        buildInterface(sourceScreen: sourceScreen, outputScreen: outputScreen)
        refreshControls()
        refreshPresets()
        startPerformanceMonitoring()
        let visibleFrame = sourceScreen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(
            x: visibleFrame.midX - panel.frame.width * 0.5,
            y: visibleFrame.midY - panel.frame.height * 0.5
        )
        panel.setFrameOrigin(origin)
        if presentWindow {
            _ = panel.setFrameUsingName("NIOWarpUnifiedWorkbench")
            panel.setFrameAutosaveName("NIOWarpUnifiedWorkbench")
            fitWindow(to: visibleFrame)
        }
        if presentWindow { bringToFront() }
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        performanceTimer?.invalidate()
        gridHistoryReset?.cancel()
        localUpdates.cancel()
    }

    override func close() {
        protoPiePanel?.disconnect()
        playbackPanel?.disconnect()
        cancelLocalUpdates()
        localEditor?.close()
        localEditor = nil
        bezierUpdates.cancel()
        bezierEditor?.close()
        bezierEditor = nil
        super.close()
    }

    private func buildInterface(sourceScreen: NSScreen?, outputScreen: NSScreen?) {
        guard let contentView = window?.contentView else { return }
        let header = NSStackView()
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 8
        header.translatesAutoresizingMaskIntoConstraints = false
        configurationTabs.translatesAutoresizingMaskIntoConstraints = false
        configurationTabs.tabViewType = .noTabsNoBorder
        configurationTabs.font = .systemFont(ofSize: 13, weight: .medium)
        configurationTabs.setAccessibilityLabel("配置分类")
        configurationTabs.setAccessibilityIdentifier("nio-workbench-inspector")
        configurationTabs.delegate = self
        modulePicker.segmentCount = Self.modules.count
        for (index, module) in Self.modules.enumerated() { modulePicker.setLabel(module.1, forSegment: index) }
        modulePicker.segmentStyle = .texturedRounded
        modulePicker.trackingMode = .selectOne
        modulePicker.selectedSegment = 0
        modulePicker.target = self
        modulePicker.action = #selector(changeModule(_:))
        modulePicker.setAccessibilityIdentifier("nio-workbench-modules")
        modulePicker.translatesAutoresizingMaskIntoConstraints = false
        let body = NSSplitView()
        standardBody = body
        body.isVertical = true
        body.dividerStyle = .thin
        body.delegate = self
        body.translatesAutoresizingMaskIntoConstraints = false
        body.addArrangedSubview(previewColumn)
        body.addArrangedSubview(configurationTabs)
        previewColumn.orientation = .vertical
        previewColumn.alignment = .leading
        previewColumn.spacing = 10
        previewColumn.edgeInsets = NSEdgeInsets(top: 10, left: 8, bottom: 8, right: 12)
        previewColumn.addArrangedSubview(previewHost)
        previewHost.setAccessibilityIdentifier("nio-workbench-preview")
        previewHost.translatesAutoresizingMaskIntoConstraints = false
        layerSummary.font = .systemFont(ofSize: 11)
        layerSummary.textColor = .secondaryLabelColor
        layerSummary.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(header)
        contentView.addSubview(modulePicker)
        contentView.addSubview(body)
        contentView.addSubview(layerSummary)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 18),
            header.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -18),
            header.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12),
            modulePicker.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            modulePicker.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            modulePicker.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            body.topAnchor.constraint(equalTo: modulePicker.bottomAnchor, constant: 10),
            body.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10),
            body.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10),
            body.bottomAnchor.constraint(equalTo: layerSummary.topAnchor, constant: -8),
            previewColumn.widthAnchor.constraint(greaterThanOrEqualToConstant: 490),
            configurationTabs.widthAnchor.constraint(greaterThanOrEqualToConstant: 350),
            configurationTabs.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
            previewHost.widthAnchor.constraint(equalTo: previewColumn.widthAnchor, constant: -20),
            previewHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 260),
            layerSummary.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            layerSummary.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            layerSummary.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
            layerSummary.heightAnchor.constraint(equalToConstant: 30),
        ])
        let preferredWidth = configurationTabs.widthAnchor.constraint(equalToConstant: 366)
        preferredWidth.priority = NSLayoutConstraint.Priority(999)
        preferredWidth.isActive = true
        inspectorWidthConstraint = preferredWidth
        let basicPage = makeTabPage(title: "画布与输入", identifier: "canvas")
        let globalPage = makeTabPage(title: "整体校正", identifier: "global")
        let localPage = NSView()
        let localItem = NSTabViewItem(identifier: "local")
        localItem.label = "局部微调"
        localItem.view = localPage
        configurationTabs.addTabViewItem(localItem)
        localToolPicker.selectedSegment = 0
        localToolPicker.target = self
        localToolPicker.action = #selector(changeLocalTool(_:))
        localToolPicker.setAccessibilityIdentifier("nio-local-tool-picker")
        for view in [localToolPicker, localInspectorHost] { view.translatesAutoresizingMaskIntoConstraints = false; localPage.addSubview(view) }
        NSLayoutConstraint.activate([
            localToolPicker.leadingAnchor.constraint(equalTo: localPage.leadingAnchor, constant: 12),
            localToolPicker.trailingAnchor.constraint(equalTo: localPage.trailingAnchor, constant: -12),
            localToolPicker.topAnchor.constraint(equalTo: localPage.topAnchor, constant: 12),
            localInspectorHost.leadingAnchor.constraint(equalTo: localPage.leadingAnchor),
            localInspectorHost.trailingAnchor.constraint(equalTo: localPage.trailingAnchor),
            localInspectorHost.topAnchor.constraint(equalTo: localToolPicker.bottomAnchor, constant: 8),
            localInspectorHost.bottomAnchor.constraint(equalTo: localPage.bottomAnchor),
        ])
        let qualityPage = makeTabPage(title: "标定与画质", identifier: "quality")
        let settingsPage = makeTabPage(title: "预设与历史", identifier: "history")
        let mouseItem = NSTabViewItem(identifier: "mouse")
        mouseItem.label = "鼠标映射"
        if let mouseMapping {
            let panel = mouseMapping.makePanel()
            mouseMappingPanel = panel
            mouseItem.view = panel.inspectorView
        } else {
            mouseItem.view = NSTextField(wrappingLabelWithString: "从正式应用启动后，可接通 ProtoPie 演示鼠标。")
        }
        configurationTabs.addTabViewItem(mouseItem)
        let protoItem = NSTabViewItem(identifier: "protopie")
        protoItem.label = "ProtoPie 联动"
        if let protoPie {
            let panel = ProtoPiePanel(coordinator: protoPie, outputPositionBinding: .init(
                read: { [weak self] in
                    guard let self else { return .init(value: 0, range: -1...1, isEnabled: false) }
                    return .init(value: self.lastAppliedConfiguration.outputVerticalOffsetPixels,
                        range: self.lastAppliedConfiguration.outputVerticalOffsetRange,
                        isEnabled: self.renderer != nil && !self.geometryValidationInFlight)
                },
                apply: { [weak self] value in self?.applyOutputVerticalOffset(value) }
            ))
            protoPiePanel = panel
            if let playback {
                let automation = ProtoPiePlaybackPanel(controller: playback)
                playbackPanel = automation
                automation.onPickPosition = { [weak self] callback in
                    guard let self, let mouseMapping = self.mouseMapping else { return }
                    playback.pause(reason: "已暂停自动演示，等待在画面上取点。")
                    Task { @MainActor in await mouseMapping.pickAutomationPoint(callback) }
                }
                let host = NSTabView()
                host.translatesAutoresizingMaskIntoConstraints = false
                host.tabViewType = .noTabsNoBorder
                host.setAccessibilityIdentifier("nio-protopie-full-workspace")
                let automationItem = NSTabViewItem(identifier: "automation")
                automationItem.label = "云端播放与自动演示"
                automationItem.view = automation.view
                host.addTabViewItem(automationItem)
                let legacyItem = NSTabViewItem(identifier: "legacy")
                legacyItem.label = "画面设置与本地 .pie"
                legacyItem.view = panel.inspectorView
                host.addTabViewItem(legacyItem)
                let workspace = NSView()
                workspace.translatesAutoresizingMaskIntoConstraints = false
                workspace.setAccessibilityIdentifier("nio-protopie-workspace-wrapper")
                let sectionPicker = NSSegmentedControl(labels: [automationItem.label, legacyItem.label],
                    trackingMode: .selectOne, target: self, action: #selector(changePlaybackSection(_:)))
                sectionPicker.segmentStyle = .rounded
                sectionPicker.segmentDistribution = .fillEqually
                sectionPicker.selectedSegment = 0
                sectionPicker.font = .systemFont(ofSize: 12, weight: .medium)
                sectionPicker.translatesAutoresizingMaskIntoConstraints = false
                sectionPicker.setAccessibilityIdentifier("nio-protopie-workspace-sections")
                sectionPicker.setAccessibilityLabel("ProtoPie 联动工作区")
                workspace.addSubview(sectionPicker)
                workspace.addSubview(host)
                contentView.addSubview(workspace)
                NSLayoutConstraint.activate([
                    workspace.leadingAnchor.constraint(equalTo: body.leadingAnchor),
                    workspace.trailingAnchor.constraint(equalTo: body.trailingAnchor),
                    workspace.topAnchor.constraint(equalTo: body.topAnchor),
                    workspace.bottomAnchor.constraint(equalTo: body.bottomAnchor),
                    sectionPicker.leadingAnchor.constraint(equalTo: workspace.leadingAnchor, constant: 10),
                    sectionPicker.trailingAnchor.constraint(equalTo: workspace.trailingAnchor, constant: -10),
                    sectionPicker.topAnchor.constraint(equalTo: workspace.topAnchor),
                    sectionPicker.heightAnchor.constraint(equalToConstant: 28),
                    host.leadingAnchor.constraint(equalTo: workspace.leadingAnchor),
                    host.trailingAnchor.constraint(equalTo: workspace.trailingAnchor),
                    host.topAnchor.constraint(equalTo: sectionPicker.bottomAnchor, constant: 8),
                    host.bottomAnchor.constraint(equalTo: workspace.bottomAnchor),
                ])
                workspace.isHidden = true
                playbackHost = host
                playbackWorkspace = workspace
                playbackSectionPicker = sectionPicker
                protoItem.view = NSView()
            } else { protoItem.view = panel.inspectorView }
            previewColumn.addArrangedSubview(panel.statusView)
            panel.statusView.widthAnchor.constraint(equalTo: previewHost.widthAnchor).isActive = true
            panel.statusView.isHidden = false
        } else {
            protoItem.view = NSTextField(wrappingLabelWithString: "ProtoPie 联动：从正式应用启动后配置云端链接或本地 .pie 文件。")
        }
        configurationTabs.addTabViewItem(protoItem)
        configurationTabs.selectTabViewItem(at: 0)
        var stack = header

        let titleRow = NSStackView()
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 10
        let title = NSTextField(labelWithString: "NIO Warp · 外屏曲面画布")
        title.font = .systemFont(ofSize: 18, weight: .bold)
        let version = NSTextField(labelWithString: AppVersion.display)
        version.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
        version.textColor = .secondaryLabelColor
        version.toolTip = "当前运行版本"
        titleRow.addArrangedSubview(title)
        titleRow.addArrangedSubview(version)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        titleRow.addArrangedSubview(spacer)
        historyButton.target = self
        historyButton.action = #selector(rollbackConfiguration)
        pauseWarpButton.target = self
        pauseWarpButton.action = #selector(toggleWarpVisibility)
        pinButton.target = self
        pinButton.action = #selector(toggleAlwaysOnTop)
        for button in [historyButton, pauseWarpButton, pinButton] { titleRow.addArrangedSubview(button) }
        let quitButton = makeButton("退出程序", action: #selector(requestQuit))
        quitButton.setAccessibilityIdentifier("nio-workbench-quit")
        titleRow.addArrangedSubview(quitButton)
        stack.addArrangedSubview(titleRow)
        titleRow.widthAnchor.constraint(equalTo: header.widthAnchor).isActive = true
        globalStatusLabel.textColor = .secondaryLabelColor
        globalStatusLabel.font = .systemFont(ofSize: 12)
        globalStatusLabel.maximumNumberOfLines = 2
        globalStatusLabel.preferredMaxLayoutWidth = 1050
        globalStatusLabel.heightAnchor.constraint(equalToConstant: 34).isActive = true
        globalStatusLabel.setAccessibilityIdentifier("nio-global-status")
        stack.addArrangedSubview(globalStatusLabel)
        globalStatusLabel.widthAnchor.constraint(equalTo: header.widthAnchor).isActive = true
        stack = basicPage
        let controlDescription = sourceScreen.map(screenName) ?? "等待系统显示器信息"
        let outputDescription = outputScreen.map(screenName) ?? "未连接；当前不捕获、不输出校正画面"
        let parameterDescription = isWaitingForDisplay
            ? "下方是已保存外屏参数的只读预览，没有历史时显示默认模板；尺寸不是笔记本内屏分辨率。"
            : "\(displayWidth)×\(displayHeight) 物理像素；先调好弯曲形状，再记住起点并增加画布宽高。"
        let topology = NSTextField(wrappingLabelWithString: "控制台：\(controlDescription)\n捕获与输出：\(outputDescription)\n\(parameterDescription)")
        topology.textColor = .secondaryLabelColor
        stack.addArrangedSubview(topology)
        if isWaitingForDisplay {
            let waiting = explanation("等待外接屏幕：程序已正常打开，画面处理尚未启动。可查看预览和导出参数；连接外屏后，灰色设置会自动恢复可操作。")
            waiting.textColor = .systemOrange
            waiting.font = .systemFont(ofSize: 13, weight: .semibold)
            stack.addArrangedSubview(waiting)
        }

        stack.addArrangedSubview(sectionTitle("0. 输入源与自动铺满"))
        CaptureSourceMode.allCases.forEach { captureSourcePicker.addItem(withTitle: $0.title) }
        captureSourcePicker.target = self
        captureSourcePicker.action = #selector(updateCaptureSourceMode)
        stack.addArrangedSubview(labeledRow("输入源", captureSourcePicker))
        capturePresentationLabel.textColor = .secondaryLabelColor
        capturePresentationLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(capturePresentationLabel)
        let captureHint = NSTextField(wrappingLabelWithString: "自动模式会识别覆盖外屏 82% 以上并连续稳定的最大窗口；播放器退出全屏或窗口关闭后自动恢复整屏捕获。内容适配选“保持比例·完整显示”可保留完整画面；“铺满裁切”会裁掉超出部分。")
        captureHint.textColor = .secondaryLabelColor
        captureHint.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(captureHint)

        stack.addArrangedSubview(sectionTitle("1. 外屏允许显示的矩形范围（AA）"))
        stack.addArrangedSubview(explanation("X 是距外屏左边的距离，Y 是距外屏上边的距离，单位都是物理像素。AA 外保持黑色；开启曲面外扩后，改 AA 只改变裁切范围，不缩放画布。"))
        stack.addArrangedSubview(fieldGrid([
            ("X", numericField(aaXField, target: .aaX, decimal: false)),
            ("Y", numericField(aaYField, target: .aaY, decimal: false)),
            ("宽", numericField(aaWidthField, target: .aaWidth, decimal: false)),
            ("高", numericField(aaHeightField, target: .aaHeight, decimal: false)),
        ]))
        stack.addArrangedSubview(buttonRow([
            makeButton("保存显示范围", action: #selector(applyAAFields)),
            makeButton("使用默认居中范围", action: #selector(centerAA)),
            makeButton("使用整个外屏", action: #selector(fullAA)),
        ]))
        aaBoundaryButton.target = self
        aaBoundaryButton.action = #selector(toggleAABoundary)
        stack.addArrangedSubview(aaBoundaryButton)

        let outputOffsetRange = configuration.outputVerticalOffsetRange
        outputVerticalOffsetSlider.setAccessibilityIdentifier("nio-output-vertical-offset")
        stack.addArrangedSubview(makeSlider(title: "整幅画面上下位置（物理 px）", slider: outputVerticalOffsetSlider,
            minimum: outputOffsetRange.lowerBound, maximum: outputOffsetRange.upperBound,
            action: #selector(updateOutputVerticalOffset)))
        outputVerticalOffsetField.setAccessibilityIdentifier("nio-output-vertical-offset-input")
        outputVerticalOffsetField.delegate = self
        outputVerticalOffsetField.target = self
        outputVerticalOffsetField.action = #selector(applyOutputVerticalOffsetField)
        let outputOffsetReset = makeButton("归零", action: #selector(resetOutputVerticalOffset))
        outputOffsetReset.setAccessibilityIdentifier("nio-output-vertical-offset-reset")
        let outputOffsetRow = NSStackView(views: [
            numericField(outputVerticalOffsetField, target: .outputVerticalOffset, decimal: true),
            NSTextField(labelWithString: "px"), outputOffsetReset,
        ])
        outputOffsetRow.orientation = .horizontal
        outputOffsetRow.spacing = 8
        stack.addArrangedSubview(outputOffsetRow)
        stack.addArrangedSubview(explanation("负值上移，正值下移，0 为原位。拖动实时保存；输入数值后按回车或离开输入框生效。整块校正画面一起平移，曲面形状与画布大小不变，超出 AA 的部分仍会被裁切。"))

        stack.addArrangedSubview(sectionTitle("2. 沿曲面延伸画布（逻辑像素）"))
        stack.addArrangedSubview(explanation("宽沿弯曲长边向左右延伸，高沿倾斜短边向上下延伸。中心不动，新增部分继续弯曲，不会重新压回 AA。逻辑像素不是四条边的物理弧长。"))
        stack.addArrangedSubview(fieldGrid([
            ("宽", numericField(canvasWidthField, target: .canvasWidth, decimal: false)),
            ("高", numericField(canvasHeightField, target: .canvasHeight, decimal: false)),
        ]))
        ContentMode.allCases.forEach { contentModePicker.addItem(withTitle: $0.title) }
        contentModePicker.target = self
        contentModePicker.action = #selector(updateContentMode)
        stack.addArrangedSubview(labeledRow("内容适配", contentModePicker))
        stack.addArrangedSubview(makeSlider(title: "水平裁切位置", slider: cropHorizontalSlider, minimum: -1, maximum: 1, action: #selector(updateCropAnchor)))
        stack.addArrangedSubview(makeSlider(title: "垂直裁切位置", slider: cropVerticalSlider, minimum: -1, maximum: 1, action: #selector(updateCropAnchor)))
        contentMappingLabel.textColor = .secondaryLabelColor
        contentMappingLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(contentMappingLabel)
        stack.addArrangedSubview(makeButton("保存并应用上面的宽和高", action: #selector(applyCanvasFields)))
        extendedWarpButton.target = self
        extendedWarpButton.action = #selector(toggleExtendedWarp)
        warpBoundaryButton.target = self
        warpBoundaryButton.action = #selector(toggleWarpBoundary)
        stack.addArrangedSubview(extendedWarpButton)
        extendedWarpButton.toolTip = "首次开启会记住当前画面；以后改宽高只延伸曲面。关闭后使用旧的 AA 适配方式；再次开启仍使用记住的起点。"
        stack.addArrangedSubview(explanation("操作顺序：① 先打开上面的曲面延伸开关；② 输入新的宽、高；③ 点击“保存并应用”。只增加画布时，原内容大小不变。"))
        stack.addArrangedSubview(buttonRow([
            makeButton("把当前画面记为外扩起点", action: #selector(rebaseCanvas)),
            makeButton("恢复到起点的宽高", action: #selector(restoreReferenceCanvas)),
        ]))
        canvasReferenceLabel.preferredMaxLayoutWidth = 490
        canvasReferenceLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(canvasReferenceLabel)
        stack.addArrangedSubview(makeButton("把内容按当前画布重新铺满", action: #selector(refillCanvasContent)))
        stack.addArrangedSubview(explanation("这一步只调整视频或桌面内容的等比缩放，多余部分裁掉；不改变曲线。画布变大不会生成新的 macOS 桌面，内容不够时可能仍有黑区。"))
        stack.addArrangedSubview(warpBoundaryButton)
        aaBoundaryButton.toolTip = "在外屏画出黄色 AA 边界，便于检查裁切位置；正常观看时可关闭。"
        warpBoundaryButton.toolTip = "在外屏画出青色曲面外边缘；边缘超出 AA 后会被裁掉，请在下面的完整曲面预览中查看。"
        geometryPreviewPicker.addItems(withTitles: ["看完整曲面（含超出 AA 的部分）", "只看 AA 内的几何范围"])
        geometryPreviewPicker.target = self
        geometryPreviewPicker.action = #selector(changeGeometryPreview)
        geometryPreviewPicker.toolTip = "只切换本控制台的小预览，不改变外屏输出、标定参数或保存配置。"
        let previewToolbar = NSStackView(views: [geometryPreviewPicker, makeButton("适合窗口", action: #selector(fitWorkbenchPreview))])
        previewToolbar.orientation = .horizontal
        previewToolbar.spacing = 8
        for view in [previewToolbar, geometryPreview, canvasMeasurementLabel] {
            view.translatesAutoresizingMaskIntoConstraints = false
            standardPreview.addSubview(view)
        }
        NSLayoutConstraint.activate([
            previewToolbar.topAnchor.constraint(equalTo: standardPreview.topAnchor),
            previewToolbar.leadingAnchor.constraint(equalTo: standardPreview.leadingAnchor),
            previewToolbar.trailingAnchor.constraint(lessThanOrEqualTo: standardPreview.trailingAnchor),
            geometryPreview.topAnchor.constraint(equalTo: previewToolbar.bottomAnchor, constant: 10),
            geometryPreview.leadingAnchor.constraint(equalTo: standardPreview.leadingAnchor),
            geometryPreview.trailingAnchor.constraint(equalTo: standardPreview.trailingAnchor),
            geometryPreview.bottomAnchor.constraint(equalTo: canvasMeasurementLabel.topAnchor, constant: -10),
            canvasMeasurementLabel.leadingAnchor.constraint(equalTo: standardPreview.leadingAnchor),
            canvasMeasurementLabel.trailingAnchor.constraint(equalTo: standardPreview.trailingAnchor),
            canvasMeasurementLabel.bottomAnchor.constraint(equalTo: standardPreview.bottomAnchor),
        ])
        geometryPreview.setAccessibilityLabel("画布几何预览：黄色是 AA，青色是曲面，灰色虚线是起点边界")
        geometryPreview.setAccessibilityIdentifier("nio-shared-geometry-preview")
        canvasMeasurementLabel.preferredMaxLayoutWidth = 490
        canvasMeasurementLabel.textColor = .secondaryLabelColor
        stack = basicPage
        stack.addArrangedSubview(sectionTitle("3. 镜像"))
        horizontalMirrorButton.target = self
        horizontalMirrorButton.action = #selector(updateMirror)
        verticalMirrorButton.target = self
        verticalMirrorButton.action = #selector(updateMirror)
        stack.addArrangedSubview(buttonRow([horizontalMirrorButton, verticalMirrorButton]))

        stack = globalPage
        stack.addArrangedSubview(sectionTitle("4. 基础校畸变"))
        warpButton.target = self
        warpButton.action = #selector(toggleWarp)
        stack.addArrangedSubview(warpButton)
        inverseWarpTrendButton.target = self
        inverseWarpTrendButton.action = #selector(toggleWarpTrend)
        stack.addArrangedSubview(inverseWarpTrendButton)
        stack.addArrangedSubview(makeSlider(title: "Warp 强度", slider: strengthSlider, minimum: 0, maximum: 2.25, action: #selector(updateStrength)))
        stack.addArrangedSubview(makeSlider(title: "上下弧度", slider: archSlider, minimum: 0, maximum: 3, action: #selector(updateArch)))
        verticalScaleSlider.setAccessibilityIdentifier("nio-vertical-aspect-scale")
        verticalScaleSlider.setAccessibilityLabel("垂直压缩 / 拉伸")
        verticalScaleReadout.setAccessibilityIdentifier("nio-vertical-aspect-value")
        stack.addArrangedSubview(makeSlider(title: "垂直压缩 / 拉伸", slider: verticalScaleSlider, minimum: 0.12, maximum: 5.5, action: #selector(updateVerticalScale), readout: verticalScaleReadout))
        stack.addArrangedSubview(buttonRow([makeButton("恢复垂直基准（1.00×）", action: #selector(resetVerticalScale))]))
        stack.addArrangedSubview(makeSlider(title: "左右不对称", slider: asymmetrySlider, minimum: -0.2, maximum: 0.2, action: #selector(updateAsymmetry)))
        stack.addArrangedSubview(makeSlider(title: "整体倾斜", slider: tiltSlider, minimum: -0.12, maximum: 0.12, action: #selector(updateTilt)))
        stack.addArrangedSubview(makeSlider(title: "水平弯曲", slider: horizontalBendSlider, minimum: -0.08, maximum: 0.08, action: #selector(updateHorizontalBend)))
        stack.addArrangedSubview(explanation("上下弧度上限为 3.00。垂直比例 1.00× 保留原校正画面，向左压缩、向右拉伸；在最终观察位置对照三列纵向重复圆，调至等宽等高。超出黄色 AA 区的部分仍会裁切。"))
        let localEditorButton = makeButton("打开局部交点精调", action: #selector(openLocalEditor))
        localEditorButton.toolTip = "切换到局部微调模块，在同一工作台点击交点，再用方向键精调。"
        stack.addArrangedSubview(localEditorButton)
        let bezierButton = makeButton("打开贝塞尔曲面控制网", action: #selector(openBezierEditor))
        bezierButton.setAccessibilityIdentifier("nio-open-bezier-editor")
        stack.addArrangedSubview(bezierButton)
        stack.addArrangedSubview(explanation("节点和手柄都驱动曲面：支持左右分区、多行联动、增加控制行列；整体参数保留。"))
        for button in [snapTiltButton, snapBendButton, centerSurfaceXButton, centerSurfaceYButton, levelSurfaceButton] {
            button.target = self
            button.action = #selector(updateSurfaceAlignment)
        }
        stack.addArrangedSubview(buttonRow([snapTiltButton, snapBendButton]))
        stack.addArrangedSubview(buttonRow([centerSurfaceXButton, centerSurfaceYButton, levelSurfaceButton]))
        stack.addArrangedSubview(makeButton("一键居中居正（保留曲率）", action: #selector(centerAndLevelSurface)))
        stack.addArrangedSubview(explanation("零点吸附：倾斜 ±0.002、水平弯曲 ±0.001 内精确归零。几何对齐按 AA 包围框居中、中心横线端点轴居正；保持曲线，不自动缩放，AA 外仍裁切。"))

        stack = globalPage
        polynomialDisclosure.target = self
        polynomialDisclosure.action = #selector(togglePolynomialDetails)
        stack.addArrangedSubview(polynomialDisclosure)
        polynomialDetails.orientation = .vertical
        polynomialDetails.alignment = .leading
        polynomialDetails.spacing = 12
        polynomialDetails.isHidden = true
        stack.addArrangedSubview(polynomialDetails)
        stack = polynomialDetails
        stack.addArrangedSubview(sectionTitle("5. 多项式增量"))
        stack.addArrangedSubview(explanation("多项式调整全局趋势，交点精调修正局部；两层叠加但参数独立。局部的一级/二级/三级是过渡等级，不是这里的多项式阶数。"))
        stack.addArrangedSubview(makeButton("打开局部交点精调", action: #selector(openLocalEditor)))
        polynomialButton.target = self
        polynomialButton.action = #selector(togglePolynomial)
        stack.addArrangedSubview(polynomialButton)
        for order in 2...5 { orderPicker.addItem(withTitle: "\(order) 阶") }
        orderPicker.target = self
        orderPicker.action = #selector(updatePolynomialOrder)
        stack.addArrangedSubview(labeledRow("阶数", orderPicker))
        termPicker.target = self
        termPicker.action = #selector(selectPolynomialTerm)
        stack.addArrangedSubview(labeledRow("当前项", termPicker))
        stack.addArrangedSubview(fieldGrid([
            ("X 系数", numericField(coefficientXField, target: .coefficientX, decimal: true)),
            ("Y 系数", numericField(coefficientYField, target: .coefficientY, decimal: true)),
        ]))
        stack.addArrangedSubview(buttonRow([
            makeButton("保存这一项的 X / Y 系数", action: #selector(applyPolynomialCoefficients)),
            makeButton("清零全部多项式系数", action: #selector(clearPolynomial)),
        ]))

        stack = qualityPage
        stack.addArrangedSubview(sectionTitle("6. 画质与标定"))
        AntiAliasingMode.enabledCases.forEach { antiAliasingPicker.addItem(withTitle: $0.title) }
        antiAliasingPicker.target = self
        antiAliasingPicker.action = #selector(updateAntiAliasing)
        antiAliasingEnabledButton.target = self
        antiAliasingEnabledButton.action = #selector(toggleAntiAliasing)
        stack.addArrangedSubview(antiAliasingEnabledButton)
        stack.addArrangedSubview(labeledRow("开启档位", antiAliasingPicker))
        automaticPerformanceButton.target = self
        automaticPerformanceButton.action = #selector(updateAutomaticPerformance)
        testPatternButton.target = self
        testPatternButton.action = #selector(updateTestPattern)
        rawCalibrationButton.target = self
        rawCalibrationButton.action = #selector(toggleRawCalibration)
        antiAliasingComparisonButton.target = self
        antiAliasingComparisonButton.action = #selector(toggleAntiAliasingComparison)
        stack.addArrangedSubview(automaticPerformanceButton)
        stack.addArrangedSubview(testPatternButton)
        stack.addArrangedSubview(explanation("设置基准画布分成几列、几行大格；合法数值实时生效并自动保存。开启曲面外扩后，增加画布只在边缘续格，不拉伸已有格子。"))
        stack.addArrangedSubview(labeledRow("基准横向列数", numericField(gridColumnsField, target: .gridColumns, decimal: false)))
        stack.addArrangedSubview(labeledRow("基准纵向行数", numericField(gridRowsField, target: .gridRows, decimal: false)))
        stack.addArrangedSubview(labeledRow("白线宽度 px", numericField(gridLineWidthField, target: .gridLineWidth, decimal: true)))
        for (field, identifier, help) in [
            (gridColumnsField, "nio-grid-columns", "基准画布横向分几列大格，填写 1～200 的整数。改列数会重新分格；只加宽画布则继续增加格子。"),
            (gridRowsField, "nio-grid-rows", "基准画布纵向分几行大格，填写 1～200 的整数。改行数会重新分格；只加高画布则继续增加格子。"),
            (gridLineWidthField, "nio-grid-line-width", "粗白线的完整标称宽度，填写 1～32 个外屏物理像素；可填小数。加减每次 1 像素，抗锯齿会保留边缘过渡。"),
        ] {
            field.formatter = nil
            field.delegate = self
            field.setAccessibilityIdentifier(identifier)
            field.setAccessibilityLabel(identifier == "nio-grid-columns" ? "基准横向列数" : identifier == "nio-grid-rows" ? "基准纵向行数" : "白线宽度（外屏物理像素）")
            field.toolTip = help
            field.setAccessibilityHelp(help)
        }
        gridSummaryLabel.preferredMaxLayoutWidth = 490
        gridSummaryLabel.textColor = .secondaryLabelColor
        gridStatusLabel.preferredMaxLayoutWidth = 490
        gridStatusLabel.setAccessibilityIdentifier("nio-grid-status")
        stack.addArrangedSubview(gridSummaryLabel)
        stack.addArrangedSubview(gridStatusLabel)
        stack.addArrangedSubview(buttonRow([rawCalibrationButton, antiAliasingComparisonButton]))
        performanceLabel.textColor = .secondaryLabelColor
        performanceLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(performanceLabel)

        stack = settingsPage
        stack.addArrangedSubview(sectionTitle("7. 预设与版本回退"))
        presetNameField.placeholderString = "例如：玻璃 A / 驾驶位"
        presetNameField.widthAnchor.constraint(equalToConstant: 194).isActive = true
        stack.addArrangedSubview(labeledRow("预设名称", presetNameField))
        presetPicker.widthAnchor.constraint(equalToConstant: 194).isActive = true
        stack.addArrangedSubview(labeledRow("已有预设", presetPicker))
        stack.addArrangedSubview(buttonRow([
            makeButton("保存预设", action: #selector(savePreset)),
            makeButton("应用预设", action: #selector(applyPreset)),
            makeButton("删除预设", action: #selector(deletePreset)),
        ]))
        stack.addArrangedSubview(explanation("撤销在顶部始终可用；全部校正模块共用一条操作历史。"))

        stack.addArrangedSubview(sectionTitle("8. 安全控制与配置文件"))
        stack.addArrangedSubview(buttonRow([
            makeButton("导入参数文件", action: #selector(importConfiguration)),
            makeButton("导出参数备份", action: #selector(exportConfiguration)),
            makeButton("重置全部参数", action: #selector(resetConfiguration)),
        ]))

        statusLabel.textColor = .systemOrange
        statusLabel.maximumNumberOfLines = 5
        statusLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(statusLabel)

        let hint = NSTextField(wrappingLabelWithString: "鼠标映射页可接通 ProtoPie Cloud 演示点击；Esc 恢复普通鼠标。⌃⌥⌘Esc 可立即隐藏外屏覆盖层。")
        hint.preferredMaxLayoutWidth = 490
        hint.textColor = .secondaryLabelColor
        stack.addArrangedSubview(hint)
        let checkboxHelp: [(NSButton, String)] = [
            (horizontalMirrorButton, "左右对调内容，AA 和曲面形状不变；标定网格也跟随翻转。"),
            (verticalMirrorButton, "上下对调内容，AA 和曲面形状不变；标定网格也跟随翻转。"),
            (warpButton, "使用下方滑杆的弧度、倾斜等设置；关闭不会删除数值，多项式仍单独控制。"),
            (inverseWarpTrendButton, "反转基础校正与多项式的位移方向，用于预抵消玻璃反射弯曲；需要实拍验证。"),
            (polynomialButton, "只开关多项式，不清空系数；翻折参数会拒绝应用。"),
            (antiAliasingEnabledButton, "平滑细线和文字边缘，关闭使用点采样；不会改变几何形状。"),
            (automaticPerformanceButton, "运行时降低采样档位以保护流畅度，不改写保存的画质选择。"),
            (testPatternButton, "用带方向角标及三列纵向重复圆的网格替代桌面；圆沿画布向上、向下等距重复，随画面一起变形，用垂直压缩 / 拉伸校准比例。关闭后恢复桌面或视频。"),
        ]
        checkboxHelp.forEach { button, text in button.toolTip = text; button.setAccessibilityHelp(text) }
        for document in tabPageDocuments {
            func fitLabels(_ view: NSView) {
                if let label = view as? NSTextField, !label.isEditable {
                    label.preferredMaxLayoutWidth = 302
                    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                }
                if let button = view as? NSButton {
                    button.font = .systemFont(ofSize: 12)
                    button.cell?.wraps = true
                }
                view.subviews.forEach(fitLabels)
            }
            fitLabels(document)
        }
        builtInterface = true
        mountModulePreview()
    }

    private func makeTabPage(title: String, identifier: String) -> NSStackView {
        let scrollView = NSScrollView(frame: .zero)
        scrollView.scrollerStyle = .overlay
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        let documentView = FlippedView()
        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView
        documentView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor).isActive = true
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 14, bottom: 20, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        documentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor),
            stack.topAnchor.constraint(equalTo: documentView.topAnchor),
            stack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor),
        ])
        let item = NSTabViewItem(identifier: identifier)
        item.label = title
        item.view = scrollView
        configurationTabs.addTabViewItem(item)
        tabPageDocuments.append(documentView)
        return stack
    }

    func selectModule(_ identifier: String) {
        guard Self.modules.contains(where: { $0.0 == identifier }) else { return }
        configurationTabs.selectTabViewItem(withIdentifier: identifier)
    }

    /// A display reconnection replaces the renderer, but should not reset the
    /// operator's navigation, camera or same-display text drafts.
    func restoreWorkspace(from previous: ControlPanelController, sameDisplay: Bool) {
        selectedLocalTool = previous.selectedLocalTool
        localToolPicker.selectedSegment = selectedLocalTool
        pinButton.state = previous.pinButton.state
        toggleAlwaysOnTop()
        polynomialDisclosure.state = previous.polynomialDisclosure.state
        togglePolynomialDetails()
        geometryPreviewPicker.selectItem(at: previous.geometryPreviewPicker.indexOfSelectedItem)
        geometryPreview.clipsToAA = previous.geometryPreview.clipsToAA
        if sameDisplay {
            if previous.selectedModuleIdentifier == "local" {
                geometryPreview.viewport = previous.selectedLocalTool == 0 ? previous.bezierEditor?.viewport : previous.localEditor?.viewport
            } else { geometryPreview.viewport = previous.geometryPreview.viewport }
            for (old, new) in zip(previous.draftFields, draftFields) {
                if let rendered = previous.renderedFieldValues[ObjectIdentifier(old)], old.stringValue != rendered { new.stringValue = old.stringValue }
            }
            if let index = previous.bezierEditor?.canvasView.selectedIndex { showBezierEditor(presentWindow: false).selectNode(index) }
            if let point = previous.localEditor?.canvasView.selectedCoordinate { showLocalEditor(presentWindow: false).select(point) }
        }
        selectModule(previous.selectedModuleIdentifier)
        window?.contentView?.layoutSubtreeIfNeeded()
        for (oldItem, newItem) in zip(previous.configurationTabs.tabViewItems, configurationTabs.tabViewItems) {
            guard let old = oldItem.view as? NSScrollView, let new = newItem.view as? NSScrollView else { continue }
            new.contentView.scroll(to: old.contentView.bounds.origin)
            new.reflectScrolledClipView(new.contentView)
        }
    }

    @objc private func changeModule(_ sender: NSSegmentedControl) {
        guard Self.modules.indices.contains(sender.selectedSegment) else { return }
        selectModule(Self.modules[sender.selectedSegment].0)
    }

    @objc private func changePlaybackSection(_ sender: NSSegmentedControl) {
        guard let host = playbackHost, host.tabViewItems.indices.contains(sender.selectedSegment) else { return }
        window?.makeFirstResponder(nil)
        host.selectTabViewItem(at: sender.selectedSegment)
    }

    func tabView(_ tabView: NSTabView, willSelect tabViewItem: NSTabViewItem?) {
        guard builtInterface else { return }
        if selectedModuleIdentifier == "local" {
            if selectedLocalTool == 0 {
                bezierEditor?.deactivateInteraction()
                geometryPreview.viewport = bezierEditor?.viewport
            } else {
                localEditor?.deactivateInteraction()
                geometryPreview.viewport = localEditor?.viewport
            }
        }
    }

    func tabView(_ tabView: NSTabView, didSelect tabViewItem: NSTabViewItem?) {
        guard builtInterface else { return }
        modulePicker.selectedSegment = Self.modules.firstIndex { $0.0 == selectedModuleIdentifier } ?? 0
        mountModulePreview()
    }

    private func mount(_ view: NSView, in host: NSView) {
        if view.superview === host { return }
        host.subviews.forEach { $0.removeFromSuperview() }
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            view.topAnchor.constraint(equalTo: host.topAnchor),
            view.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
    }

    private func mountModulePreview() {
        guard builtInterface else { return }
        let showPlayback = selectedModuleIdentifier == "protopie" && playbackHost != nil
        standardBody?.isHidden = showPlayback
        playbackWorkspace?.isHidden = !showPlayback
        if selectedModuleIdentifier == "local" {
            if selectedLocalTool == 0 {
                let editor = showBezierEditor(presentWindow: false)
                editor.prepareForEmbedding()
                mount(editor.embeddedPreview, in: previewHost)
                mount(editor.embeddedInspector, in: localInspectorHost)
                window?.contentView?.layoutSubtreeIfNeeded()
                editor.viewport = geometryPreview.viewport
            } else {
                let editor = showLocalEditor(presentWindow: false)
                editor.prepareForEmbedding()
                mount(editor.embeddedPreview, in: previewHost)
                mount(editor.embeddedInspector, in: localInspectorHost)
                window?.contentView?.layoutSubtreeIfNeeded()
                editor.viewport = geometryPreview.viewport
            }
        } else { mount(standardPreview, in: previewHost) }
    }

    @objc private func changeLocalTool(_ sender: NSSegmentedControl) {
        guard selectedLocalTool != sender.selectedSegment else { return }
        if selectedLocalTool == 0 {
            bezierEditor?.deactivateInteraction(); geometryPreview.viewport = bezierEditor?.viewport
        } else {
            localEditor?.deactivateInteraction(); geometryPreview.viewport = localEditor?.viewport
        }
        selectedLocalTool = sender.selectedSegment
        mountModulePreview()
    }

    @objc private func fitWorkbenchPreview() { geometryPreview.fit() }
    func splitView(_ splitView: NSSplitView, constrainSplitPosition proposedPosition: CGFloat, ofSubviewAt dividerIndex: Int) -> CGFloat {
        let width = min(max(splitView.bounds.width - proposedPosition - splitView.dividerThickness, 350), 440)
        if NSApp.currentEvent?.type == .leftMouseDragged { inspectorWidthConstraint?.constant = width }
        return splitView.bounds.width - (inspectorWidthConstraint?.constant ?? width) - splitView.dividerThickness
    }
    @objc private func togglePolynomialDetails() { polynomialDetails.isHidden = polynomialDisclosure.state != .on }
    @objc private func toggleAlwaysOnTop() { window?.level = pinButton.state == .on ? .floating : .normal }

    @objc private func requestQuit() {
        guard let window, window.attachedSheet == nil, quitConfirmation == nil else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "退出 NIO Warp？"
        alert.informativeText = "退出后将停止画面校正并恢复原始桌面。已保存的参数会保留，尚未应用的输入会丢弃。"
        let cancelButton = alert.addButton(withTitle: "取消")
        let confirmButton = alert.addButton(withTitle: "退出程序")
        quitConfirmation = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            self.quitConfirmation = nil
            if response == .alertSecondButtonReturn { self.terminateApplication() }
        }
        // NSAlert assigns button shortcuts while presenting the sheet.
        confirmButton.keyEquivalent = ""
        cancelButton.keyEquivalent = "\r"
        alert.window.defaultButtonCell = cancelButton.cell as? NSButtonCell
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        setWarpVisible(false)
        protoPie?.setOutputPaused(true)
        updateWarpVisibilityState(false)
        return true
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), let number = Int(event.charactersIgnoringModifiers ?? ""), (1...7).contains(number) {
            selectModule(Self.modules[number - 1].0)
            return
        }
        super.keyDown(with: event)
    }

    private func screenName(_ screen: NSScreen) -> String {
        "\(screen.localizedName) · \(Int(screen.frame.width))×\(Int(screen.frame.height)) pt"
    }

    private func sectionTitle(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        return label
    }

    private func makeButton(_ title: String, action: Selector, target: AnyObject? = nil) -> NSButton {
        let button = NSButton(title: title, target: target ?? self, action: action)
        let help = [
            "applyAAFields": "同时保存上面的 X、Y、宽、高。AA 外保持黑色。",
            "centerAA": "把 AA 恢复成屏幕中部的 88% 宽、48% 高；不是仅移动当前矩形。",
            "fullAA": "允许使用整个外屏。曲面外扩开启时，不会自动放大曲面。",
            "applyCanvasFields": "同时保存宽和高；开启曲面延伸后只增加坐标范围，不重设起点。",
            "rebaseCanvas": "将已应用的当前曲面和尺寸设为新的外扩起点，原形状不变。一般只在重新标定时使用。",
            "restoreReferenceCanvas": "只恢复记住的画布宽高；不清空弧度、多项式、镜像或 AA。",
            "refillCanvasContent": "按当前画布比例等比铺满内容，裁切多余部分；不会压扁，也不改变曲面。",
            "applyPolynomialCoefficients": "保存当前选择项的 X、Y 系数。若曲面翻折则拒绝应用并保留原参数。",
            "clearPolynomial": "清空所有多项式微调，基础校正和镜像保持不变。可撤销。",
            "savePreset": "用填写的名字保存当前全部参数（含外扩起点）；同名预设会被替换。",
            "applyPreset": "加载选中的参数组；外屏分辨率不匹配时拒绝应用。",
            "deletePreset": "删除选中的已保存参数组，不改变当前画面。",
            "importConfiguration": "导入完整参数备份或单独多项式 JSON。无效配置不会覆盖当前画面。",
            "exportConfiguration": "保存当前全部参数到 JSON 文件，方便备份或迁移；不会修改画面。",
            "resetConfiguration": "恢复当前显示器的初始设置，包括 AA、画布、曲线、镜像和外扩起点；操作前再次确认。",
            "requestQuit": "确认后退出 NIO Warp，移除外屏覆盖层，显示原始桌面。",
        ]
        button.toolTip = help[NSStringFromSelector(action)] ?? title
        button.setAccessibilityHelp(button.toolTip)
        return button
    }

    private func explanation(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = 302
        return label
    }

    private func buttonRow(_ views: [NSView]) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .vertical
        row.alignment = .leading
        row.spacing = 8
        return row
    }

    private func labeledRow(_ title: String, _ view: NSView) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        label.widthAnchor.constraint(equalToConstant: 94).isActive = true
        let row = NSStackView(views: [label, view])
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    private func fieldGrid(_ fields: [(String, NSView)]) -> NSGridView {
        let rows = fields.chunked(into: 1).map { group -> [NSView] in
            var views = [NSView]()
            for item in group {
                let label = NSTextField(labelWithString: item.0)
                views.append(label)
                views.append(item.1)
            }
            return views
        }
        let grid = NSGridView(views: rows)
        grid.rowSpacing = 8
        grid.columnSpacing = 8
        return grid
    }

    private func numericField(_ field: NSTextField, target: NumericFieldTarget, decimal: Bool) -> NSView {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.allowsFloats = decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = decimal ? 8 : 0
        field.formatter = formatter
        field.alignment = .right
        field.widthAnchor.constraint(equalToConstant: 92).isActive = true

        let minus = makeButton("−", action: #selector(adjustNumericField(_:)))
        minus.tag = target.rawValue * 2
        minus.widthAnchor.constraint(equalToConstant: 28).isActive = true
        let plus = makeButton("+", action: #selector(adjustNumericField(_:)))
        plus.tag = target.rawValue * 2 + 1
        plus.widthAnchor.constraint(equalToConstant: 28).isActive = true
        minus.toolTip = decimal ? "减小 0.001，立即保存并应用这一组系数。" : "减小 1 像素，立即保存并应用这一组数值。"
        plus.toolTip = decimal ? "增加 0.001，立即保存并应用这一组系数。" : "增加 1 像素，立即保存并应用这一组数值。"
        if [.gridColumns, .gridRows, .gridLineWidth].contains(target) {
            let unit = target == .gridLineWidth ? "像素线宽" : "个基准大格"
            minus.toolTip = "减少 1 \(unit)，网格实时更新并自动保存。"
            plus.toolTip = "增加 1 \(unit)，网格实时更新并自动保存。"
        }
        if target == .outputVerticalOffset {
            minus.toolTip = "整幅画面上移 1 物理像素，立即保存并应用。"
            plus.toolTip = "整幅画面下移 1 物理像素，立即保存并应用。"
        }

        let row = NSStackView(views: [minus, field, plus])
        row.orientation = .horizontal
        row.spacing = 4
        return row
    }

    private func makeSlider(title: String, slider: NSSlider, minimum: Double, maximum: Double, action: Selector, readout: NSTextField? = nil) -> NSView {
        let container = NSStackView()
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = 4
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        slider.minValue = minimum
        slider.maxValue = maximum
        slider.target = self
        slider.action = action
        slider.isContinuous = true
        slider.widthAnchor.constraint(equalToConstant: 296).isActive = true
        if let readout {
            readout.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            readout.alignment = .right
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let header = NSStackView(views: [label, spacer, readout])
            header.orientation = .horizontal
            header.widthAnchor.constraint(equalToConstant: 296).isActive = true
            container.addArrangedSubview(header)
        } else {
            container.addArrangedSubview(label)
        }
        container.addArrangedSubview(slider)
        return container
    }

    private func refreshControls() {
        protoPiePanel?.refreshOutputPosition()
        let drafts = draftFields.compactMap { field -> (NSTextField, String)? in
            guard let previous = renderedFieldValues[ObjectIdentifier(field)], field.stringValue != previous else { return nil }
            return (field, field.stringValue)
        }
        defer {
            for field in draftFields { renderedFieldValues[ObjectIdentifier(field)] = field.stringValue }
            for (field, text) in drafts { field.stringValue = text }
        }
        let aa = configuration.aaRect.sanitized()
        aaXField.stringValue = String(Int((aa.x * Double(displayWidth)).rounded()))
        aaYField.stringValue = String(Int((aa.y * Double(displayHeight)).rounded()))
        aaWidthField.stringValue = String(Int((aa.width * Double(displayWidth)).rounded()))
        aaHeightField.stringValue = String(Int((aa.height * Double(displayHeight)).rounded()))
        canvasWidthField.stringValue = String(configuration.canvas.width)
        canvasHeightField.stringValue = String(configuration.canvas.height)
        cropHorizontalSlider.doubleValue = configuration.cropAnchor.horizontal
        cropVerticalSlider.doubleValue = configuration.cropAnchor.vertical
        outputVerticalOffsetSlider.minValue = configuration.outputVerticalOffsetRange.lowerBound
        outputVerticalOffsetSlider.maxValue = configuration.outputVerticalOffsetRange.upperBound
        outputVerticalOffsetSlider.doubleValue = configuration.outputVerticalOffsetPixels
        outputVerticalOffsetField.stringValue = NumericInput.formattedDouble(configuration.outputVerticalOffsetPixels)
        horizontalMirrorButton.state = configuration.mirror.horizontal ? .on : .off
        verticalMirrorButton.state = configuration.mirror.vertical ? .on : .off
        warpButton.state = configuration.manual.enabled ? .on : .off
        inverseWarpTrendButton.state = configuration.warpTrend == .inverse ? .on : .off
        polynomialButton.state = configuration.polynomial.enabled ? .on : .off
        strengthSlider.doubleValue = configuration.manual.strength
        archSlider.doubleValue = configuration.manual.arch
        verticalScaleSlider.doubleValue = configuration.manual.verticalAspectScale
        verticalScaleReadout.stringValue = String(format: "%.2f×", configuration.manual.verticalAspectScale)
        asymmetrySlider.doubleValue = configuration.manual.asymmetry
        tiltSlider.doubleValue = configuration.manual.tilt
        horizontalBendSlider.doubleValue = configuration.manual.horizontalBend
        snapTiltButton.state = configuration.alignment.snapTilt ? .on : .off
        snapBendButton.state = configuration.alignment.snapHorizontalBend ? .on : .off
        centerSurfaceXButton.state = configuration.alignment.centerHorizontal ? .on : .off
        centerSurfaceYButton.state = configuration.alignment.centerVertical ? .on : .off
        levelSurfaceButton.state = configuration.alignment.level ? .on : .off
        contentModePicker.selectItem(at: ContentMode.allCases.firstIndex(of: configuration.contentMode) ?? 0)
        captureSourcePicker.selectItem(at: CaptureSourceMode.allCases.firstIndex(of: configuration.capture.sourceMode) ?? 0)
        antiAliasingEnabledButton.state = configuration.render.antiAliasingEnabled ? .on : .off
        antiAliasingPicker.selectItem(at: AntiAliasingMode.enabledCases.firstIndex(of: configuration.render.antiAliasing) ?? 0)
        antiAliasingPicker.isEnabled = configuration.render.antiAliasingEnabled
        automaticPerformanceButton.isEnabled = configuration.render.antiAliasingEnabled
        automaticPerformanceButton.state = configuration.render.automaticPerformanceFallback ? .on : .off
        testPatternButton.state = configuration.render.testPattern == .calibrationGrid ? .on : .off
        gridColumnsField.stringValue = String(configuration.render.calibrationGrid.columns)
        gridRowsField.stringValue = String(configuration.render.calibrationGrid.rows)
        gridLineWidthField.stringValue = NumericInput.formattedDouble(configuration.render.calibrationGrid.lineWidthPixels)
        aaBoundaryButton.state = configuration.render.showAABoundary ? .on : .off
        extendedWarpButton.state = configuration.extendedWarpEnabled ? .on : .off
        warpBoundaryButton.state = configuration.render.showWarpBoundary ? .on : .off
        pauseWarpButton.title = isWarpVisible() ? "暂时显示原始桌面" : "重新显示校正画面"
        pauseWarpButton.toolTip = "只隐藏或恢复覆盖层，不清空任何参数；与重置参数不同。"
        historyButton.title = "撤销上一次设置（\(historyStore.count)）"
        historyButton.toolTip = historyStore.all().last.map { "撤销：\($0.reason)" } ?? "暂无可撤销的校正修改"
        historyButton.isEnabled = historyStore.count > 0
        orderPicker.selectItem(at: configuration.polynomial.order - 2)
        rebuildTermPicker()
        refreshContentMappingStatus()
        refreshRuntimePreviewControls()
        refreshCanvasGeometry()
        if isWaitingForDisplay { configureWaitingControls() }
        synchronizeLocalEditor()
    }

    private func markFieldDraftsApplied(_ fields: [NSTextField]) {
        for field in fields { renderedFieldValues[ObjectIdentifier(field)] = field.stringValue }
    }

    private func configureWaitingControls() {
        func disableEditing(in view: NSView) {
            for child in view.subviews {
                if let field = child as? NSTextField {
                    if field.isEditable { field.isEnabled = false }
                } else if let control = child as? NSControl {
                    let canUseOffline = control === geometryPreviewPicker
                        || control === polynomialDisclosure
                        || control.action == #selector(openLocalEditor)
                        || control.action == #selector(openBezierEditor)
                        || control.action == #selector(exportConfiguration)
                    control.isEnabled = canUseOffline
                }
                disableEditing(in: child)
            }
        }
        tabPageDocuments.forEach { disableEditing(in: $0) }
        historyButton.isEnabled = false
        pauseWarpButton.isEnabled = false
        capturePresentationLabel.stringValue = "待机：尚未开始屏幕捕获；连接外屏后会自动启用。"
        globalStatusLabel.stringValue = capturePresentationLabel.stringValue
        performanceLabel.stringValue = "待机中：没有启动 Warp 渲染或性能采样。"
        pauseWarpButton.title = "等待外屏，暂不输出"
    }

    private func rebuildTermPicker() {
        let previous = max(termPicker.indexOfSelectedItem, 0)
        termPicker.removeAllItems()
        PolynomialWarpConfiguration.terms(order: configuration.polynomial.order).forEach { term in
            termPicker.addItem(withTitle: term.label)
        }
        termPicker.selectItem(at: min(previous, max(termPicker.numberOfItems - 1, 0)))
        refreshCoefficientFields()
    }

    private func refreshCoefficientFields() {
        let index = max(termPicker.indexOfSelectedItem, 0)
        let polynomial = configuration.polynomial.normalized()
        coefficientXField.stringValue = NumericInput.formattedDouble(polynomial.coefficientsX[index])
        coefficientYField.stringValue = NumericInput.formattedDouble(polynomial.coefficientsY[index])
    }

    private func applyConfiguration(_ message: String, recordHistory: Bool = true) {
        guard !geometryValidationInFlight else {
            configuration = lastAppliedConfiguration
            refreshControls()
            setStatus("正在校验局部修改，请稍候再调整；当前有效画面保留。", color: .systemOrange)
            return
        }
        cancelLocalUpdates()
        finishGridEditingSession()
        guard let renderer else {
            configuration = lastAppliedConfiguration
            refreshControls()
            setStatus("当前没有可用外屏，设置未应用。请连接外屏后再修改；已保存的外屏参数没有改变。", color: .systemOrange)
            return
        }
        let errors = configuration.validationErrors()
        if !errors.isEmpty {
            configuration = lastAppliedConfiguration
            refreshControls()
            setStatus("没有应用：\(errors.joined(separator: "；"))。已保留上一次有效设置。", color: .systemRed)
            return
        }
        let candidate = configuration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        if playback?.runtime.isActive == true { playback?.pause(reason: "校正参数正在手动调整，自动演示已暂停。") }
        let validation = renderer.updateConfiguration(candidate)
        guard validation.isValid else {
            configuration = lastAppliedConfiguration
            refreshControls()
            setStatus("没有应用本次修改：\(validation.summary)。已保留原画面和配置。", color: .systemRed)
            return
        }
        runtimePreviewMode = .normal
        runtimePreviewReturnMode = .normal
        configuration = candidate
        if recordHistory, configuration != lastAppliedConfiguration {
            historyStore.record(lastAppliedConfiguration, reason: message)
        }
        store.save(configuration)
        updateAABoundary(configuration.aaRect, configuration.render.showAABoundary)
        updateWarpBoundary(configuration, configuration.render.showWarpBoundary)
        if configuration.capture != lastAppliedConfiguration.capture {
            applyCaptureConfiguration(configuration.capture)
        }
        if configuration.canvas != lastAppliedConfiguration.canvas {
            protoPie?.setPresentationCanvas(configuration.canvas)
        }
        lastAppliedConfiguration = configuration
        protoPiePanel?.refreshOutputPosition()
        historyButton.title = "撤销上一次设置（\(historyStore.count)）"
        historyButton.isEnabled = historyStore.count > 0
        let color: NSColor = validation.isValid ? .systemGreen : .systemRed
        setStatus("\(message)；\(validation.summary)", color: color)
        refreshRuntimePreviewControls()
        refreshContentMappingStatus()
        refreshCanvasGeometry()
        synchronizeLocalEditor()
    }

    private func refreshContentMappingStatus(sourceWidth: Int? = nil, sourceHeight: Int? = nil) {
        if let sourceWidth { captureSourceWidth = sourceWidth }
        if let sourceHeight { captureSourceHeight = sourceHeight }
        let effectiveSourceWidth = captureSourceWidth
        let effectiveSourceHeight = captureSourceHeight
        let mapping = ContentMappingMath.mapping(
            sourceWidth: Float(effectiveSourceWidth),
            sourceHeight: Float(effectiveSourceHeight),
            targetWidth: Float(configuration.contentCanvas.width),
            targetHeight: Float(configuration.contentCanvas.height),
            mode: configuration.contentMode,
            anchor: configuration.cropAnchor
        )
        let cropX = Int((mapping.cropFraction.x * Float(effectiveSourceWidth)).rounded())
        let cropY = Int((mapping.cropFraction.y * Float(effectiveSourceHeight)).rounded())
        let warning = configuration.contentMode == .stretch ? " ⚠️ 拉伸会改变画面比例" : ""
        let extensionSummary: String
        if configuration.extendedWarpEnabled {
            let core = WarpMath.extendedWarpCoreRect(configuration: configuration)
            extensionSummary = String(
                format: " · 外扩起点 %.0f×%.0f 逻辑像素",
                Double(configuration.canvas.width) * core.width,
                Double(configuration.canvas.height) * core.height
            )
        } else {
            extensionSummary = ""
        }
        contentMappingLabel.stringValue = String(
            format: "源 %.4f · 目标 %.4f · 等比缩放 %.4fx · 裁切 X %d px / Y %d px%@%@",
            Float(effectiveSourceWidth) / Float(max(effectiveSourceHeight, 1)),
            configuration.contentCanvas.aspect,
            mapping.uniformScale,
            cropX,
            cropY,
            warning,
            extensionSummary
        )
        contentMappingLabel.textColor = configuration.contentMode == .stretch ? .systemOrange : .secondaryLabelColor
    }

    private func refreshRuntimePreviewControls() {
        rawCalibrationButton.title = runtimePreviewMode == .rawReflectionCalibration ? "返回校正画面" : "临时显示未校正网格"
        rawCalibrationButton.toolTip = "临时关闭弯曲和外扩，显示矩形网格，供拍摄玻璃反射；不会覆盖保存的校正参数。再次点击返回。"
        antiAliasingComparisonButton.title = runtimePreviewMode == .antiAliasingComparison ? "结束对比，返回原画面" : "对比抗锯齿：左关 / 右开"
        antiAliasingComparisonButton.toolTip = "左右显示完全相同的图案，唯一差别是抗锯齿；不修改保存参数，退出后恢复进入前状态。"
        refreshGridSummary()
    }

    private func refreshGridSummary() {
        let active = renderer?.activeConfiguration ?? configuration
        gridSummaryLabel.stringValue = configuration.calibrationGridSummary
        gridStatusLabel.textColor = .secondaryLabelColor
        if isWaitingForDisplay {
            gridStatusLabel.stringValue = "待机只读：接上外屏后可修改。基础配置的小图仅示意曲面，不显示这些标定网格参数。"
        } else if active.render.testPattern == .antiAliasingComparison {
            gridStatusLabel.stringValue = "当前是抗锯齿专用对比图，网格参数不影响该图。结束对比后按网格设置显示。"
        } else if active.render.testPattern == .off {
            gridStatusLabel.stringValue = "参数已保存。勾选“显示标定网格”或进入未校正网格后，才能看到变化。"
        } else if runtimePreviewMode == .rawReflectionCalibration {
            gridStatusLabel.stringValue = "未校正预览：只按基准行列数铺满 AA，不展示正常外扩覆盖量。仍可实时调网格，不退出预览、不覆盖校正参数。"
        } else {
            gridStatusLabel.stringValue = "已实时生效并自动保存。只调大格与粗白线；每大格内保留 5 等分灰线，红绿中心线和方向角标不变。"
        }
    }

    private func isGridField(_ object: Any?) -> Bool {
        guard let field = object as? NSTextField else { return false }
        return field === gridColumnsField || field === gridRowsField || field === gridLineWidthField
    }

    func controlTextDidBeginEditing(_ notification: Notification) {
        guard isGridField(notification.object) else { return }
        finishGridEditingSession()
    }

    func controlTextDidChange(_ notification: Notification) {
        guard isGridField(notification.object) else { return }
        applyGridFields()
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        if let field = notification.object as? NSTextField, field === outputVerticalOffsetField {
            applyOutputVerticalOffsetField()
            return
        }
        guard isGridField(notification.object) else { return }
        applyGridFields()
        finishGridEditingSession()
    }

    private func applyGridFields() {
        guard !geometryValidationInFlight else {
            gridStatusLabel.stringValue = "局部修改正在校验，请稍候再应用网格参数。"
            gridStatusLabel.textColor = .systemOrange
            return
        }
        guard let renderer else { return }
        guard let columns = Int(NumericInput.normalized(gridColumnsField.stringValue)),
              let rows = Int(NumericInput.normalized(gridRowsField.stringValue)),
              let width = NumericInput.double(from: gridLineWidthField.stringValue) else {
            gridStatusLabel.stringValue = "本次输入尚未应用：请填完整的行列数和线宽；画面保留上一组有效数值。"
            gridStatusLabel.textColor = .systemOrange
            return
        }
        let grid = CalibrationGridConfiguration(columns: columns, rows: rows, lineWidthPixels: width)
        guard grid.isValid else {
            gridStatusLabel.stringValue = "本次输入未应用：行列须为 1～200 的整数，线宽须为 1～32 像素；没有改动其他数值。"
            gridStatusLabel.textColor = .systemOrange
            return
        }
        guard grid != configuration.render.calibrationGrid else { refreshGridSummary(); return }
        guard renderer.updateCalibrationGrid(grid) else { return }
        if !gridHistoryRecorded {
            historyStore.record(lastAppliedConfiguration, reason: "调整标定网格", force: true)
            gridHistoryRecorded = true
        }
        configuration.render.calibrationGrid = grid
        lastAppliedConfiguration.render.calibrationGrid = grid
        store.save(lastAppliedConfiguration)
        historyButton.title = "撤销上一次设置（\(historyStore.count)）"
        historyButton.isEnabled = historyStore.count > 0
        refreshGridSummary()
        cancelLocalUpdates()
        synchronizeLocalEditor()
    }

    private func finishGridEditingSession() {
        gridHistoryReset?.cancel()
        gridHistoryReset = nil
        gridHistoryRecorded = false
    }

    private func stepGridField(_ target: NumericFieldTarget, direction: Double) {
        guard renderer != nil else { return }
        window?.makeFirstResponder(nil)
        switch target {
        case .gridColumns:
            let parsed = Int(NumericInput.normalized(gridColumnsField.stringValue)) ?? configuration.render.calibrationGrid.columns
            let value = min(max(parsed, 1), 200)
            gridColumnsField.stringValue = String(min(max(value + Int(direction), 1), 200))
        case .gridRows:
            let parsed = Int(NumericInput.normalized(gridRowsField.stringValue)) ?? configuration.render.calibrationGrid.rows
            let value = min(max(parsed, 1), 200)
            gridRowsField.stringValue = String(min(max(value + Int(direction), 1), 200))
        case .gridLineWidth:
            let value = NumericInput.double(from: gridLineWidthField.stringValue) ?? configuration.render.calibrationGrid.lineWidthPixels
            gridLineWidthField.stringValue = NumericInput.formattedDouble(min(max(value + direction, 1), 32))
        default: return
        }
        applyGridFields()
        gridHistoryReset?.cancel()
        let reset = DispatchWorkItem { [weak self] in self?.finishGridEditingSession() }
        gridHistoryReset = reset
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(750), execute: reset)
    }

    private func refreshCanvasGeometry() {
        layerSummary.stringValue = "当前叠加：整体 \(configuration.manual.enabled ? "开" : "关") · 贝塞尔 \(configuration.bezierWarp.enabled ? "开" : "关") · 交点 \(configuration.localWarp.enabled ? "开" : "关") · 多项式 \(configuration.polynomial.enabled ? "开" : "关")     紧急恢复 ⌃⌥⌘Esc"
        let previewConfiguration: WarpConfiguration
        switch runtimePreviewMode {
        case .normal: previewConfiguration = configuration
        case .rawReflectionCalibration: previewConfiguration = configuration.rawReflectionCalibrationConfiguration()
        case .antiAliasingComparison: previewConfiguration = configuration.antiAliasingComparisonConfiguration()
        }
        let summary = geometryPreview.update(previewConfiguration)
        canvasMeasurementLabel.stringValue = summary.measurementText
        if let reference = configuration.canvasReference {
            let horizontalGrowth = Double(configuration.canvas.width - reference.canvas.width) / 2
            let verticalGrowth = Double(configuration.canvas.height - reference.canvas.height) / 2
            canvasReferenceLabel.stringValue = String(
                format: "%@ · 记住的起点：%d × %d；当前：%d × %d。\n相对起点：左右各 %+.0f，上下各 %+.0f 逻辑像素（负数表示收回）。",
                configuration.extendedWarpEnabled ? "曲面延伸已开启" : "曲面延伸已关闭，起点仍保留",
                reference.canvas.width, reference.canvas.height, configuration.canvas.width, configuration.canvas.height,
                horizontalGrowth, verticalGrowth
            )
        } else {
            canvasReferenceLabel.stringValue = "尚未记住外扩起点。首次开启会记住当前已应用的画布；之后改宽高不会改写起点。"
        }
    }

    private func canvasFieldsAreSaved() -> Bool {
        NumericInput.integer(from: canvasWidthField.stringValue) == configuration.canvas.width
            && NumericInput.integer(from: canvasHeightField.stringValue) == configuration.canvas.height
    }

    @objc private func changeGeometryPreview() {
        geometryPreview.clipsToAA = geometryPreviewPicker.indexOfSelectedItem == 1
    }

    @objc private func rebaseCanvas() {
        guard canvasFieldsAreSaved() else {
            setStatus("宽高还没保存。请先点击“保存并应用上面的宽和高”，再记住外扩起点。", color: .systemOrange)
            return
        }
        let alert = NSAlert()
        alert.messageText = "把当前画面作为新的外扩起点？"
        alert.informativeText = "将记住当前 \(configuration.canvas.width) × \(configuration.canvas.height) 的尺寸和位置。当前曲线与内容大小不变；以后恢复起点会恢复到这个尺寸。旧起点可用“撤销上一次设置”找回。"
        alert.addButton(withTitle: "记住当前画面")
        alert.addButton(withTitle: "取消，不改动")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        configuration.rebaseCanvasGrowth()
        applyConfiguration("已记住新的外扩起点；曲线形状不变")
        refreshControls()
    }

    @objc private func restoreReferenceCanvas() {
        guard let reference = configuration.canvasReference else {
            setStatus("还没有外扩起点。请先开启曲面延伸，或点击“把当前画面记为外扩起点”。", color: .systemOrange)
            return
        }
        configuration.canvas = reference.canvas
        applyConfiguration("已恢复到起点的宽高；弧度、多项式和 AA 没有清空")
        refreshControls()
    }

    @objc private func refillCanvasContent() {
        guard canvasFieldsAreSaved() else {
            setStatus("请先保存上面的宽和高，再按当前画布重新铺满内容。", color: .systemOrange)
            return
        }
        configuration.refillContentCanvas()
        configuration.contentMode = .fill
        applyConfiguration("内容已按当前画布等比铺满，多余部分裁切；曲线与外扩起点不变")
        refreshControls()
    }

    private func applyRuntimePreview(_ previewConfiguration: WarpConfiguration, message: String) {
        cancelLocalUpdates()
        finishGridEditingSession()
        guard let renderer else { return }
        let preview = previewConfiguration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        let validation = renderer.updateConfiguration(preview)
        updateWarpBoundary(preview, preview.render.showWarpBoundary)
        refreshCanvasGeometry()
        refreshRuntimePreviewControls()
        let color: NSColor = validation.isValid ? .systemOrange : .systemRed
        setStatus("\(message)；临时预览不会保存配置或增加历史。\n\(validation.summary)", color: color)
        synchronizeLocalEditor()
    }

    private func leaveRuntimePreview(message: String = "已返回校正状态") {
        cancelLocalUpdates()
        finishGridEditingSession()
        guard let renderer else { return }
        runtimePreviewMode = .normal
        runtimePreviewReturnMode = .normal
        let validation = renderer.updateConfiguration(configuration)
        updateWarpBoundary(configuration, configuration.render.showWarpBoundary)
        refreshRuntimePreviewControls()
        refreshCanvasGeometry()
        let color: NSColor = validation.isValid ? .systemGreen : .systemRed
        setStatus("\(message)；\(validation.summary)", color: color)
        synchronizeLocalEditor()
    }

    private var canEditLocalWarp: Bool { renderer != nil && runtimePreviewMode == .normal }

    private func canSubmitGeometry(_ source: String) -> Bool {
        canEditLocalWarp && (!geometryValidationInFlight || geometryValidationSource == source)
    }

    private func cancelLocalUpdates() {
        geometryValidationInFlight = false
        geometryValidationSource = nil
        bezierHistoryBaseline = nil
        bezierUpdates.cancel()
        localUpdates.cancel()
        localHistoryBaseline = nil
    }

    private func synchronizeLocalEditor(message: String? = nil) {
        if geometryValidationInFlight {
            bezierEditor?.setEditingAvailable(canSubmitGeometry("bezier"))
            localEditor?.setEditingAvailable(canSubmitGeometry("local"))
            return
        }
        bezierEditor?.synchronize(configuration: configuration, available: canSubmitGeometry("bezier"), message: message)
        guard let localEditor else { return }
        let rendered = renderer?.activeConfiguration ?? configuration
        let dimensions = WarpMath.meshDimensions(configuration: rendered)
        let mesh = renderer?.currentMesh ?? WarpMath.makeMesh(configuration: rendered, columns: dimensions.columns, rows: dimensions.rows)
        localEditor.synchronize(configuration: configuration, renderedConfiguration: rendered, mesh: mesh, available: canSubmitGeometry("local"), message: message)
    }

    @objc private func openBezierEditor() { showBezierEditor() }

    @discardableResult
    func showBezierEditor(presentWindow: Bool = true) -> BezierWarpEditorController {
        if bezierEditor == nil {
            let editor = BezierWarpEditorController(configuration: configuration, available: canSubmitGeometry("bezier"), embedded: true)
            editor.window?.title = "NIO Warp · 贝塞尔曲面控制网 · \(AppVersion.display)"
            editor.onChange = { [weak self] bezier, history in self?.applyBezierWarp(bezier, recordHistory: history) }
            editor.onUndo = { [weak self] in
                guard let self, self.canEditLocalWarp else { return }
                self.rollbackConfiguration()
                self.synchronizeLocalEditor()
            }
            editor.onClose = { [weak self] in
                self?.bezierUpdates.cancel()
                self?.geometryValidationInFlight = false
                self?.bezierHistoryBaseline = nil
            }
            bezierEditor = editor
        }
        if presentWindow {
            if selectedModuleIdentifier == "local", selectedLocalTool != 0 { localEditor?.deactivateInteraction(); geometryPreview.viewport = localEditor?.viewport }
            selectedLocalTool = 0
            localToolPicker.selectedSegment = 0
            if selectedModuleIdentifier == "local" { mountModulePreview() } else { selectModule("local") }
        }
        return bezierEditor!
    }

    private func applyBezierWarp(_ bezier: BezierWarpConfiguration, recordHistory: Bool) {
        guard let renderer, canSubmitGeometry("bezier") else { return }
        let historyBaseline = bezierHistoryBaseline ?? (recordHistory ? lastAppliedConfiguration : nil)
        cancelLocalUpdates()
        bezierHistoryBaseline = historyBaseline
        let baseline = lastAppliedConfiguration
        var candidate = baseline
        candidate.bezierWarp = bezier
        geometryValidationInFlight = true
        geometryValidationSource = "bezier"
        historyButton.title = "取消待应用的贝塞尔修改"
        historyButton.isEnabled = true
        setStatus("正在校验贝塞尔修改；可以切换模块或暂停输出。", color: .systemOrange)
        localEditor?.setEditingAvailable(false)
        bezierUpdates.submit(candidate) { [weak self] result in
            guard let self else { return }
            self.geometryValidationInFlight = false
            self.geometryValidationSource = nil
            guard self.canEditLocalWarp, self.lastAppliedConfiguration == baseline else { return }
            switch result {
            case .failure(let error):
                self.synchronizeLocalEditor()
                self.bezierHistoryBaseline = nil
                self.bezierEditor?.showStatus("未应用：\(error.message)。保留上一有效画面。", error: true)
                self.setStatus("贝塞尔修改未应用：\(error.message)。保留上一有效画面。", color: .systemRed)
            case .success(let mesh):
                guard renderer.installPreparedConfiguration(candidate, mesh: mesh) else { return }
                if let previous = self.bezierHistoryBaseline, previous != candidate { self.historyStore.record(previous, reason: "贝塞尔曲面调节", force: true) }
                self.bezierHistoryBaseline = nil
                self.configuration = candidate
                self.lastAppliedConfiguration = candidate
                self.store.save(candidate)
                self.updateWarpBoundary(candidate, candidate.render.showWarpBoundary)
                self.refreshControls()
                self.bezierEditor?.showStatus("已应用并保存；\(mesh.validation.summary)", error: false)
                self.setStatus("贝塞尔修改已保存；\(mesh.validation.summary)")
            }
        }
    }

    @objc private func updateSurfaceAlignment() {
        configuration.alignment.snapTilt = snapTiltButton.state == .on
        configuration.alignment.snapHorizontalBend = snapBendButton.state == .on
        configuration.alignment.centerHorizontal = centerSurfaceXButton.state == .on
        configuration.alignment.centerVertical = centerSurfaceYButton.state == .on
        configuration.alignment.level = levelSurfaceButton.state == .on
        configuration.manual.tilt = WarpAlignmentConfiguration.snapped(configuration.manual.tilt, enabled: configuration.alignment.snapTilt, threshold: 0.002)
        configuration.manual.horizontalBend = WarpAlignmentConfiguration.snapped(configuration.manual.horizontalBend, enabled: configuration.alignment.snapHorizontalBend, threshold: 0.001)
        applyConfiguration("吸附与曲面几何对齐已更新；局部形状保留")
        refreshControls()
    }

    @objc private func centerAndLevelSurface() {
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.alignment.level = true
        applyConfiguration("画面已按 AA 基准居中居正，保留所有局部曲率")
        refreshControls()
    }

    @objc private func openLocalEditor() { showLocalEditor() }

    @discardableResult
    func showLocalEditor(presentWindow: Bool = true) -> LocalWarpEditorController {
        if localEditor == nil {
            let rendered = renderer?.activeConfiguration ?? configuration
            let dimensions = WarpMath.meshDimensions(configuration: rendered)
            let mesh = renderer?.currentMesh ?? WarpMath.makeMesh(configuration: rendered, columns: dimensions.columns, rows: dimensions.rows)
            let editor = LocalWarpEditorController(configuration: configuration, renderedConfiguration: rendered, mesh: mesh, available: canSubmitGeometry("local"), screen: window?.screen, embedded: true)
            editor.window?.title = "NIO Warp · 局部交点精调 · \(AppVersion.display)"
            editor.onChange = { [weak self] local, history in self?.applyLocalWarp(local, recordHistory: history) }
            editor.onUndo = { [weak self] in
                guard let self, self.canEditLocalWarp else { return }
                self.rollbackConfiguration()
                self.synchronizeLocalEditor()
            }
            editor.onClose = { [weak self] in
                self?.localUpdates.cancel()
                self?.geometryValidationInFlight = false
                self?.localHistoryBaseline = nil
            }
            editor.onShowPolynomial = { [weak self] in self?.showGlobalPolynomialSettings() }
            localEditor = editor
        }
        if presentWindow {
            if selectedModuleIdentifier == "local", selectedLocalTool != 1 { bezierEditor?.deactivateInteraction(); geometryPreview.viewport = bezierEditor?.viewport }
            selectedLocalTool = 1
            localToolPicker.selectedSegment = 1
            if selectedModuleIdentifier == "local" { mountModulePreview() } else { selectModule("local") }
        }
        return localEditor!
    }

    func showGlobalPolynomialSettings(presentWindow: Bool = true) {
        selectModule("global")
        polynomialDisclosure.state = .on
        polynomialDetails.isHidden = false
        window?.contentView?.layoutSubtreeIfNeeded()
        orderPicker.scrollToVisible(orderPicker.bounds)
        if presentWindow {
            showWindow(nil)
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func applyLocalWarp(_ local: LocalWarpConfiguration, recordHistory: Bool) {
        guard let renderer, canSubmitGeometry("local") else { return }
        // The two editors share the same output configuration. Switching layers
        // cancels the other pending draft, so an older completion cannot win.
        bezierUpdates.cancel()
        bezierHistoryBaseline = nil
        bezierEditor?.synchronize(configuration: configuration, available: canEditLocalWarp)
        let baseline = lastAppliedConfiguration
        if recordHistory { localHistoryBaseline = baseline }
        var candidate = baseline
        candidate.localWarp = local
        geometryValidationInFlight = true
        geometryValidationSource = "local"
        historyButton.title = "取消待应用的交点修改"
        historyButton.isEnabled = true
        setStatus("正在校验交点修改；可以切换模块或暂停输出。", color: .systemOrange)
        bezierEditor?.setEditingAvailable(false)
        localUpdates.submit(candidate) { [weak self] result in
            guard let self else { return }
            self.geometryValidationInFlight = false
            self.geometryValidationSource = nil
            guard self.canEditLocalWarp, self.lastAppliedConfiguration == baseline else { return }
            switch result {
            case .failure(let error):
                self.localHistoryBaseline = nil
                self.synchronizeLocalEditor()
                self.localEditor?.showStatus("没有应用：\(error.message)。原画面和数据保留。", error: true)
                self.setStatus("交点修改未应用：\(error.message)。保留上一有效画面。", color: .systemRed)
            case .success(let mesh):
                guard renderer.installPreparedConfiguration(candidate, mesh: mesh) else { return }
                if let previous = self.localHistoryBaseline, previous != candidate { self.historyStore.record(previous, reason: "局部交点精调", force: true) }
                self.localHistoryBaseline = nil
                self.configuration = candidate
                self.lastAppliedConfiguration = candidate
                self.store.save(candidate)
                self.updateWarpBoundary(candidate, candidate.render.showWarpBoundary)
                self.historyButton.title = "撤销上一次设置（\(self.historyStore.count)）"
                self.historyButton.isEnabled = self.historyStore.count > 0
                self.refreshCanvasGeometry()
                self.synchronizeLocalEditor(message: "局部修正已应用并自动保存；\(mesh.validation.summary)。")
                self.setStatus("局部修正已保存；\(mesh.validation.summary)")
            }
        }
    }

    private func restoreRuntimePreview(_ mode: RuntimePreviewMode) {
        switch mode {
        case .rawReflectionCalibration:
            runtimePreviewMode = .rawReflectionCalibration
            runtimePreviewReturnMode = .normal
            applyRuntimePreview(
                configuration.rawReflectionCalibrationConfiguration(),
                message: "已返回无畸变标定：基础/多项式 Warp 保持临时关闭"
            )
        case .normal, .antiAliasingComparison:
            leaveRuntimePreview()
        }
    }

    private func startPerformanceMonitoring() {
        guard renderer != nil else { return }
        performanceTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.refreshPerformanceStatus()
        }
    }

    private func refreshPerformanceStatus() {
        guard let renderer else { return }
        let didFallback = renderer.evaluateAutomaticPerformanceFallback()
        let snapshot = renderer.performanceSnapshot()
        let effective = renderer.effectiveAntiAliasingMode.title
        let saved = configuration.render.antiAliasingEnabled ? configuration.render.antiAliasing.title : "关闭"
        performanceLabel.stringValue = String(
            format: "FPS %.1f · GPU 平均 %.2f ms · P95 %.2f ms · 保存：%@ · 当前：%@",
            snapshot.framesPerSecond,
            snapshot.averageGPUTimeMilliseconds,
            snapshot.p95GPUTimeMilliseconds,
            saved,
            effective
        )
        performanceLabel.textColor = snapshot.sampleCount >= 60 && snapshot.framesPerSecond < 55 ? .systemOrange : .secondaryLabelColor
        if didFallback {
            setStatus("质量模式未达到 55 FPS / 14 ms 门槛，已自动降至性能模式；保存配置未改变。", color: .systemOrange)
        }
    }

    private func refreshPresets(selecting id: UUID? = nil) {
        presets = presetStore.all()
        presetPicker.removeAllItems()
        presets.forEach { presetPicker.addItem(withTitle: $0.name) }
        if let id, let index = presets.firstIndex(where: { $0.id == id }) {
            presetPicker.selectItem(at: index)
        }
    }

    func setStatus(_ text: String, color: NSColor = .systemGreen) {
        statusLabel.stringValue = text
        statusLabel.textColor = color
        globalStatusLabel.stringValue = text
        globalStatusLabel.textColor = color
        globalStatusLabel.toolTip = text
    }

    func updateCapturePresentation(_ presentation: CapturePresentation) {
        capturePresentationLabel.stringValue = presentation.summary
        switch presentation {
        case let .entireDisplay(width, height):
            refreshContentMappingStatus(sourceWidth: width, sourceHeight: height)
        case .waitingForFullscreenWindow:
            refreshContentMappingStatus(sourceWidth: displayWidth, sourceHeight: displayHeight)
        case let .fullscreenWindow(_, _, width, height):
            refreshContentMappingStatus(sourceWidth: width, sourceHeight: height)
        }
    }

    func bringToFront() {
        guard let window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        let screens = NSScreen.screens.filter { screen in
            guard let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else { return false }
            return !OwnedPresentationDisplay.isOwnedDisplay(id) && CGDisplayIsActive(id) != 0 && CGDisplayIsAsleep(id) == 0
        }
        let screenID: (NSScreen) -> CGDirectDisplayID? = {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        }
        // AppKit can migrate the window to an external screen while the lid is
        // closed. Resolve the current built-in screen again when showing it.
        let controlScreen = screens.first { screenID($0).map { CGDisplayIsBuiltin($0) != 0 } ?? false }
            ?? screens.first { screenID($0) == preferredControlDisplayID }
            ?? screens.first { $0 === window.screen }
            ?? screens.first { $0 === NSScreen.main }
            ?? screens.first
        if let controlScreen { fitWindow(to: controlScreen.visibleFrame) }
        window.orderFrontRegardless()
        window.makeKey()
    }

    func fitWindow(to visibleFrame: NSRect) {
        guard let window, visibleFrame.width > 0, visibleFrame.height > 0 else { return }
        let content = window.contentRect(forFrameRect: window.frame)
        let decoration = NSSize(width: window.frame.width - content.width, height: window.frame.height - content.height)
        window.contentMinSize = WorkbenchWindowPlacement.minimumContentSize(in: visibleFrame, frameDecoration: decoration)
        window.setFrame(WorkbenchWindowPlacement.containedFrame(window.frame, in: visibleFrame), display: false)
    }

    @objc private func applyAAFields() {
        guard !geometryValidationInFlight else { setStatus("局部修改正在校验，请稍候再保存显示范围。", color: .systemOrange); return }
        markFieldDraftsApplied([aaXField, aaYField, aaWidthField, aaHeightField])
        let aa = configuration.aaRect.sanitized()
        let currentX = Int((aa.x * Double(displayWidth)).rounded())
        let currentY = Int((aa.y * Double(displayHeight)).rounded())
        let currentWidth = Int((aa.width * Double(displayWidth)).rounded())
        let currentHeight = Int((aa.height * Double(displayHeight)).rounded())
        configuration.aaRect = NormalizedRect(
            x: Double(NumericInput.integer(from: aaXField.stringValue) ?? currentX) / Double(displayWidth),
            y: Double(NumericInput.integer(from: aaYField.stringValue) ?? currentY) / Double(displayHeight),
            width: Double(NumericInput.integer(from: aaWidthField.stringValue) ?? currentWidth) / Double(displayWidth),
            height: Double(NumericInput.integer(from: aaHeightField.stringValue) ?? currentHeight) / Double(displayHeight)
        )
        applyConfiguration("AA 区已应用")
        refreshControls()
    }

    @objc private func updateCaptureSourceMode() {
        configuration.capture.sourceMode = CaptureSourceMode.allCases[captureSourcePicker.indexOfSelectedItem]
        applyConfiguration(
            configuration.capture.sourceMode == .automaticFullscreenWindow
                ? "输入源已切换为自动跟随全屏窗口"
                : "输入源已切换为整个外接屏幕"
        )
    }

    @objc private func centerAA() {
        configuration.aaRect = NormalizedRect(x: 0.06, y: 0.26, width: 0.88, height: 0.48)
        applyConfiguration("AA 区已居中")
        refreshControls()
    }

    @objc private func fullAA() {
        configuration.aaRect = .full
        applyConfiguration("AA 区已设为全屏")
        refreshControls()
    }

    @objc private func applyCanvasFields() {
        guard !geometryValidationInFlight else { setStatus("局部修改正在校验，请稍候再保存画布。", color: .systemOrange); return }
        markFieldDraftsApplied([canvasWidthField, canvasHeightField])
        guard let width = NumericInput.integer(from: canvasWidthField.stringValue),
              let height = NumericInput.integer(from: canvasHeightField.stringValue),
              (64...32768).contains(width), (64...32768).contains(height) else {
            setStatus("宽和高都要填写 64～32768 之间的整数；两个数一起保存，本次没有改动画面。", color: .systemRed)
            return
        }
        configuration.canvas = CanvasConfiguration(width: width, height: height)
        applyConfiguration(configuration.extendedWarpEnabled ? "已沿原曲线更新画布宽高；没有重设起点或缩放内容" : "已保存画布尺寸；曲面延伸尚未开启")
        refreshControls()
    }

    @objc private func updateContentMode() {
        configuration.contentMode = ContentMode.allCases[contentModePicker.indexOfSelectedItem]
        applyConfiguration("内容适配已更新")
    }

    @objc private func updateCropAnchor() {
        configuration.cropAnchor = CropAnchorConfiguration(
            horizontal: cropHorizontalSlider.doubleValue,
            vertical: cropVerticalSlider.doubleValue
        )
        applyConfiguration("裁切位置已更新")
    }

    @objc private func updateMirror() {
        configuration.mirror.horizontal = horizontalMirrorButton.state == .on
        configuration.mirror.vertical = verticalMirrorButton.state == .on
        applyConfiguration("镜像已更新")
    }

    @objc private func updateAntiAliasing() {
        configuration.render.antiAliasing = AntiAliasingMode.enabledCases[antiAliasingPicker.indexOfSelectedItem]
        applyConfiguration("抗锯齿档位已更新")
    }

    @objc private func toggleAntiAliasing() {
        configuration.render.antiAliasingEnabled = antiAliasingEnabledButton.state == .on
        applyConfiguration(configuration.render.antiAliasingEnabled ? "抗锯齿已开启" : "抗锯齿已关闭")
        refreshControls()
    }

    @objc private func updateAutomaticPerformance() {
        configuration.render.automaticPerformanceFallback = automaticPerformanceButton.state == .on
        applyConfiguration("自动性能保护已更新")
    }

    @objc private func updateTestPattern() {
        configuration.render.testPattern = testPatternButton.state == .on ? .calibrationGrid : .off
        applyConfiguration("标定测试图已更新")
    }

    @objc private func toggleAABoundary() {
        configuration.render.showAABoundary = aaBoundaryButton.state == .on
        applyConfiguration(
            configuration.render.showAABoundary
                ? "AA 区物理边界线已显示"
                : "AA 区物理边界线已关闭"
        )
    }

    @objc private func toggleExtendedWarp() {
        if extendedWarpButton.state == .on {
            guard canvasFieldsAreSaved() else {
                extendedWarpButton.state = configuration.extendedWarpEnabled ? .on : .off
                setStatus("请先保存输入中的宽高，再开启曲面延伸，避免把未确认的尺寸记成起点。", color: .systemOrange)
                return
            }
            configuration.enableCanvasGrowth()
        } else {
            configuration.extendedWarpEnabled = false
        }
        applyConfiguration(
            configuration.extendedWarpEnabled
                ? "曲面延伸已开启；现在增加宽高会向外生长，超过 AA 的部分仅裁切"
                : "曲面延伸已关闭，使用旧的 AA 适配方式；记住的起点仍保留"
        )
        refreshControls()
    }

    @objc private func toggleWarpBoundary() {
        configuration.render.showWarpBoundary = warpBoundaryButton.state == .on
        applyConfiguration(
            configuration.render.showWarpBoundary
                ? "Warp 区域边缘线已显示"
                : "Warp 区域边缘线已关闭"
        )
    }

    @objc private func toggleRawCalibration() {
        if runtimePreviewMode == .rawReflectionCalibration {
            leaveRuntimePreview()
            return
        }
        runtimePreviewMode = .rawReflectionCalibration
        applyRuntimePreview(
            configuration.rawReflectionCalibrationConfiguration(),
            message: "原始反射标定中：基础/多项式 Warp 已临时关闭，AA 区与镜像保持不变"
        )
    }

    @objc private func toggleAntiAliasingComparison() {
        if runtimePreviewMode == .antiAliasingComparison {
            restoreRuntimePreview(runtimePreviewReturnMode)
            return
        }
        runtimePreviewReturnMode = runtimePreviewMode
        runtimePreviewMode = .antiAliasingComparison
        applyRuntimePreview(
            configuration.antiAliasingComparisonConfiguration(),
            message: "抗锯齿 A/B：固定使用无畸变几何，左侧关闭，右侧使用当前档位"
        )
    }

    @objc private func toggleWarpVisibility() {
        let nextVisible = !isWarpVisible()
        setWarpVisible(nextVisible)
        updateWarpVisibilityState(nextVisible)
        setStatus(nextVisible ? "Warp 覆盖层已恢复。" : "Warp 覆盖层已暂停，外屏恢复原始桌面。", color: nextVisible ? .systemGreen : .systemOrange)
    }

    func updateWarpVisibilityState(_ visible: Bool, notifyProtoPie: Bool = true) {
        if notifyProtoPie { protoPie?.setOutputPaused(!visible) }
        if isWaitingForDisplay {
            pauseWarpButton.title = "等待外屏，暂不输出"
            return
        }
        pauseWarpButton.title = visible ? "暂时显示原始桌面" : "重新显示校正画面"
    }

    @objc private func toggleWarp() {
        configuration.manual.enabled = warpButton.state == .on
        applyConfiguration("基础 Warp 已更新")
    }

    @objc private func toggleWarpTrend() {
        configuration.warpTrend = inverseWarpTrendButton.state == .on ? .inverse : .forward
        applyConfiguration("畸变趋势已切换为：\(configuration.warpTrend.title)")
    }

    @objc private func updateStrength(_ sender: NSSlider) { configuration.manual.strength = sender.doubleValue; applyConfiguration("Warp 强度已更新") }
    @objc private func updateArch(_ sender: NSSlider) { configuration.manual.arch = sender.doubleValue; applyConfiguration("上下弧度已更新") }
    @objc private func updateVerticalScale(_ sender: NSSlider) {
        configuration.manual.verticalAspectScale = sender.doubleValue
        applyConfiguration("垂直压缩 / 拉伸已更新")
        refreshControls()
    }
    @objc private func resetVerticalScale() {
        configuration.manual.verticalAspectScale = 1
        applyConfiguration("垂直比例已恢复为 1.00×；原有基础校正保留")
        refreshControls()
    }
    @objc private func updateAsymmetry(_ sender: NSSlider) { configuration.manual.asymmetry = sender.doubleValue; applyConfiguration("左右不对称已更新") }
    @objc private func updateTilt(_ sender: NSSlider) { configuration.manual.tilt = WarpAlignmentConfiguration.snapped(sender.doubleValue, enabled: configuration.alignment.snapTilt, threshold: 0.002); sender.doubleValue = configuration.manual.tilt; applyConfiguration(configuration.manual.tilt == 0 && configuration.alignment.snapTilt ? "整体倾斜已吸附到精确零点" : "整体倾斜已更新") }
    @objc private func updateHorizontalBend(_ sender: NSSlider) { configuration.manual.horizontalBend = WarpAlignmentConfiguration.snapped(sender.doubleValue, enabled: configuration.alignment.snapHorizontalBend, threshold: 0.001); sender.doubleValue = configuration.manual.horizontalBend; applyConfiguration(configuration.manual.horizontalBend == 0 && configuration.alignment.snapHorizontalBend ? "水平弯曲已吸附到精确零点" : "水平弯曲已更新") }

    @objc private func togglePolynomial() {
        configuration.polynomial.enabled = polynomialButton.state == .on
        applyConfiguration("多项式增量已更新")
    }

    @objc private func updatePolynomialOrder() {
        configuration.polynomial.order = orderPicker.indexOfSelectedItem + 2
        configuration.polynomial = configuration.polynomial.normalized()
        rebuildTermPicker()
        applyConfiguration("多项式阶数已更新")
    }

    @objc private func selectPolynomialTerm() { refreshCoefficientFields() }

    @objc private func applyPolynomialCoefficients() {
        guard !geometryValidationInFlight else { setStatus("局部修改正在校验，请稍候再保存系数。", color: .systemOrange); return }
        markFieldDraftsApplied([coefficientXField, coefficientYField])
        let index = max(termPicker.indexOfSelectedItem, 0)
        configuration.polynomial = configuration.polynomial.normalized()
        configuration.polynomial.coefficientsX[index] = NumericInput.double(from: coefficientXField.stringValue)
            ?? configuration.polynomial.coefficientsX[index]
        configuration.polynomial.coefficientsY[index] = NumericInput.double(from: coefficientYField.stringValue)
            ?? configuration.polynomial.coefficientsY[index]
        applyConfiguration("多项式系数已应用")
        refreshCoefficientFields()
    }

    @objc private func adjustNumericField(_ sender: NSButton) {
        guard let target = NumericFieldTarget(rawValue: sender.tag / 2) else { return }
        let direction = sender.tag.isMultiple(of: 2) ? -1.0 : 1.0

        switch target {
        case .aaX:
            adjustIntegerField(aaXField, delta: Int(direction), minimum: 0, maximum: displayWidth - 1)
            applyAAFields()
        case .aaY:
            adjustIntegerField(aaYField, delta: Int(direction), minimum: 0, maximum: displayHeight - 1)
            applyAAFields()
        case .aaWidth:
            adjustIntegerField(aaWidthField, delta: Int(direction), minimum: 1, maximum: displayWidth)
            applyAAFields()
        case .aaHeight:
            adjustIntegerField(aaHeightField, delta: Int(direction), minimum: 1, maximum: displayHeight)
            applyAAFields()
        case .canvasWidth:
            adjustIntegerField(canvasWidthField, delta: Int(direction), minimum: 64, maximum: 32768)
            applyCanvasFields()
        case .canvasHeight:
            adjustIntegerField(canvasHeightField, delta: Int(direction), minimum: 64, maximum: 32768)
            applyCanvasFields()
        case .coefficientX:
            adjustDoubleField(coefficientXField, delta: direction * 0.001)
            applyPolynomialCoefficients()
        case .coefficientY:
            adjustDoubleField(coefficientYField, delta: direction * 0.001)
            applyPolynomialCoefficients()
        case .gridColumns, .gridRows, .gridLineWidth:
            stepGridField(target, direction: direction)
        case .outputVerticalOffset:
            let value = NumericInput.double(from: outputVerticalOffsetField.stringValue) ?? configuration.outputVerticalOffsetPixels
            applyOutputVerticalOffset(value + direction)
        }
    }

    @objc private func updateOutputVerticalOffset() {
        applyOutputVerticalOffset(outputVerticalOffsetSlider.doubleValue)
    }

    @objc private func applyOutputVerticalOffsetField() {
        guard let value = NumericInput.double(from: outputVerticalOffsetField.stringValue), value.isFinite else {
            setStatus("上下位置未应用：请输入有效的物理像素数值；原画面保持不变。", color: .systemOrange)
            return
        }
        applyOutputVerticalOffset(value)
    }

    @objc private func resetOutputVerticalOffset() {
        applyOutputVerticalOffset(0)
    }

    private func applyOutputVerticalOffset(_ value: Double) {
        guard value.isFinite else { return }
        let range = configuration.outputVerticalOffsetRange
        let bounded = min(max(value, range.lowerBound), range.upperBound)
        markFieldDraftsApplied([outputVerticalOffsetField])
        guard bounded != configuration.outputVerticalOffsetPixels else { refreshControls(); return }
        configuration.outputVerticalOffsetPixels = bounded
        applyConfiguration("整幅画面上下位置已更新（\(NumericInput.formattedDouble(bounded)) px）")
        refreshControls()
    }

    private func adjustIntegerField(_ field: NSTextField, delta: Int, minimum: Int, maximum: Int) {
        let value = NumericInput.integer(from: field.stringValue) ?? minimum
        field.stringValue = String(min(max(value + delta, minimum), maximum))
    }

    private func adjustDoubleField(_ field: NSTextField, delta: Double) {
        let value = NumericInput.double(from: field.stringValue) ?? 0
        field.stringValue = NumericInput.formattedDouble(value + delta)
    }

    @objc private func clearPolynomial() {
        let count = PolynomialWarpConfiguration.coefficientCount(order: configuration.polynomial.order)
        configuration.polynomial.coefficientsX = Array(repeating: 0, count: count)
        configuration.polynomial.coefficientsY = Array(repeating: 0, count: count)
        refreshCoefficientFields()
        applyConfiguration("多项式系数已清零")
    }

    @objc private func savePreset() {
        do {
            let preset = try presetStore.save(name: presetNameField.stringValue, configuration: configuration)
            refreshPresets(selecting: preset.id)
            presetNameField.stringValue = preset.name
            setStatus("预设已保存：\(preset.name)")
        } catch {
            setStatus("保存预设失败：\(error.localizedDescription)", color: .systemRed)
        }
    }

    @objc private func applyPreset() {
        let index = presetPicker.indexOfSelectedItem
        guard presets.indices.contains(index) else {
            setStatus("没有可应用的预设。", color: .systemOrange)
            return
        }
        let preset = presets[index]
        guard preset.configuration.displayPixelWidth == displayWidth,
              preset.configuration.displayPixelHeight == displayHeight else {
            setStatus(
                "预设 \(preset.name) 面向 \(preset.configuration.displayPixelWidth)×\(preset.configuration.displayPixelHeight)，当前外屏为 \(displayWidth)×\(displayHeight)，已拒绝应用。",
                color: .systemRed
            )
            return
        }
        configuration = preset.configuration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        refreshControls()
        applyConfiguration("已应用预设：\(preset.name)")
    }

    @objc private func deletePreset() {
        let index = presetPicker.indexOfSelectedItem
        guard presets.indices.contains(index) else { return }
        let preset = presets[index]
        do {
            try presetStore.delete(id: preset.id)
            refreshPresets()
            setStatus("预设已删除：\(preset.name)")
        } catch {
            setStatus("删除预设失败：\(error.localizedDescription)", color: .systemRed)
        }
    }

    @objc private func rollbackConfiguration() {
        guard renderer != nil else { return }
        let wasValidating = geometryValidationInFlight
        cancelLocalUpdates()
        if wasValidating {
            configuration = lastAppliedConfiguration
            refreshControls()
            setStatus("已取消待应用的局部修改；已保存画面与历史保留。")
            return
        }
        guard let revision = historyStore.popLatest() else {
            setStatus("没有可回退的历史版本。", color: .systemOrange)
            return
        }
        configuration = revision.configuration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        refreshControls()
        applyConfiguration("已回退：\(revision.reason)", recordHistory: false)
    }

    @objc private func importConfiguration() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            configuration = try store.importData(
                data,
                baseConfiguration: configuration,
                displayWidth: displayWidth,
                displayHeight: displayHeight
            )
            refreshControls()
            applyConfiguration("配置已导入：\(url.lastPathComponent)")
        } catch {
            setStatus("导入失败：\(error.localizedDescription)", color: .systemRed)
        }
    }

    @objc private func exportConfiguration() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "nio-warp-configuration.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try store.exportData(configuration).write(to: url, options: .atomic)
            setStatus("配置已导出：\(url.path)")
        } catch {
            setStatus("导出失败：\(error.localizedDescription)", color: .systemRed)
        }
    }

    @objc private func resetConfiguration() {
        let alert = NSAlert()
        alert.messageText = "重置当前外屏的全部参数？"
        alert.informativeText = "将恢复 AA、画布、弧度、多项式、镜像和外扩起点的默认设置。已保存的命名预设不删除；重置后可撤销一次。"
        alert.addButton(withTitle: "重置全部参数")
        alert.addButton(withTitle: "取消，保留现状")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        configuration = .defaultConfiguration(displayWidth: displayWidth, displayHeight: displayHeight)
        refreshControls()
        applyConfiguration("已恢复默认配置")
    }
}

private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

@MainActor private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let captureEngine = CaptureEngine()
    private let protoPie = ProtoPieCoordinator()
    private let mouseMapping = MouseMappingController()
    private lazy var playback = ProtoPiePlaybackController(
        store: ProtoPiePlaybackStore(legacy: protoPie.saved), log: ProtoPiePlaybackLog())
    private var playbackObserver: UUID?
    private var protoPieReleaseTask: Task<Void, Never>?
    private let configurationStore = ConfigurationStore()
    private var outputController: OutputController?
    private var controlPanel: ControlPanelController?
    private var emergencyHotKey: GlobalHotKey?
    private let presentationExit = PresentationExitCapture()
    private var lastVisiblePointer: CGPoint?
    private var isReconfiguring = false
    private var screenChangeWorkItem: DispatchWorkItem?
    private var startupRetryWorkItem: DispatchWorkItem?
    private var captureStartupTask: Task<Void, Never>?
    private var sessionEpoch = 0
    private var waitingMessage: String?
    private var workspaceDisplayIdentifier: String?
    private var displaysAsleep = false
    private var outputDisplayState: WarpOutputDisplayState?
    private var controlDisplayID: CGDirectDisplayID?
    private var headlessWorkbenchRequested = false
    private var outputWasDisconnected = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppPresentationPolicy.ensureAccessoryPolicy(reason: .startup)
        configureProtoPie()
        configureMouseMapping()
        configurePlayback()
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        let show = NSMenuItem(title: "显示 NIO Warp 工作台", action: #selector(showWorkbench), keyEquivalent: "0")
        show.target = self
        appMenu.addItem(show)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 NIO Warp", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        NSApp.mainMenu = menu
        emergencyHotKey = GlobalHotKey(keyCode: UInt32(kVK_Escape), modifiers: UInt32(controlKey | cmdKey | optionKey)) { [weak self] in
            self?.emergencyHideWarp(reason: "已通过 ⌃⌥⌘Esc 紧急隐藏 Warp 覆盖层。", userInitiated: true)
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(presentationSpaceChanged),
            name: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(screensDidSleep),
            name: NSWorkspace.screensDidSleepNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(screensDidWake),
            name: NSWorkspace.screensDidWakeNotification,
            object: nil
        )
        startSession()
        if emergencyHotKey == nil {
            controlPanel?.setStatus("警告：全局紧急快捷键注册失败，请使用控制台的“暂时显示原始桌面”。", color: .systemRed)
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        AppPresentationPolicy.ensureAccessoryPolicy(reason: .applicationActivation)
        if let output = outputController, output.isWarpVisible { output.restorePresentation() }
    }

    @objc private func presentationSpaceChanged() {
        // Rejoin the current Space without activating the workbench or taking
        // input away from the player. A deliberately paused output stays paused.
        if let output = outputController, output.isWarpVisible { output.restorePresentation() }
    }

    private func startSession() {
        startupRetryWorkItem?.cancel()
        guard !displaysAsleep else { return }
        sessionEpoch += 1
        let epoch = sessionEpoch
        guard let topology = chooseScreens(),
              let outputID = displayID(for: topology.output) else {
            showWaitingControlPanel(message: waitingForScreenMessage())
            scheduleStartupRetry()
            return
        }
        let displayMode = CGDisplayCopyDisplayMode(outputID)
        let pixelWidth = displayMode?.pixelWidth ?? CGDisplayPixelsWide(outputID)
        let pixelHeight = displayMode?.pixelHeight ?? CGDisplayPixelsHigh(outputID)
        guard pixelWidth > 0, pixelHeight > 0 else {
            showWaitingControlPanel(message: "外屏像素信息尚未就绪，控制台保持待机；就绪后会自动启用。")
            scheduleStartupRetry()
            return
        }
        let displayIdentifier = displayProfileIdentifier(for: outputID)
        let sameDisplay = workspaceDisplayIdentifier == displayIdentifier
        workspaceDisplayIdentifier = displayIdentifier
        let configuration = configurationStore.load(
            displayIdentifier: displayIdentifier,
            displayWidth: pixelWidth,
            displayHeight: pixelHeight
        )
        guard let outputController = OutputController(
            screen: topology.output,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            frameStore: captureEngine.frameStore,
            configuration: configuration
        ) else {
            showWaitingControlPanel(message: "外屏图形输出尚未就绪，控制台保持待机；程序会自动重试。")
            scheduleStartupRetry()
            return
        }
        self.outputController = outputController
        outputController.onWillHide = { [weak self] in self?.mouseMapping.stop(reason: "演示已暂停，已恢复普通鼠标。") }
        outputDisplayState = displayState(for: topology.output)
        controlDisplayID = topology.source.flatMap(displayID)
        let previousPanel = controlPanel
        let controlPanel = ControlPanelController(
            renderer: outputController.renderer,
            store: configurationStore,
            configuration: configuration,
            sourceScreen: topology.source,
            outputScreen: topology.output,
            setWarpVisible: { [weak self, weak outputController] visible in
                if visible { self?.hideWorkbenchOnOutputScreen() }
                outputController?.setWarpVisible(visible)
            },
            isWarpVisible: { [weak outputController] in outputController?.isWarpVisible ?? false },
            applyCaptureConfiguration: { [weak self] captureConfiguration in
                Task { @MainActor [weak self] in
                    guard self?.sessionEpoch == epoch else { return }
                    do {
                        try await self?.captureEngine.updateSourceMode(
                            captureConfiguration.sourceMode,
                            minimumCoverage: captureConfiguration.fullscreenCoverageThreshold
                        )
                    } catch {
                        guard self?.sessionEpoch == epoch else { return }
                        self?.controlPanel?.setStatus(
                            "切换输入源失败：\(error.localizedDescription)。已保留当前捕获。",
                            color: .systemOrange
                        )
                    }
                }
            },
            updateAABoundary: { [weak outputController] aaRect, visible in
                outputController?.updateAABoundary(aaRect: aaRect, visible: visible)
            },
            updateWarpBoundary: { [weak outputController] configuration, visible in
                outputController?.updateWarpBoundary(configuration: configuration, visible: visible)
            }, presentWindow: topology.source != nil, protoPie: protoPie, mouseMapping: mouseMapping, playback: playback
        )
        if let previousPanel { controlPanel.restoreWorkspace(from: previousPanel, sameDisplay: sameDisplay) }
        self.controlPanel = controlPanel
        waitingMessage = nil
        previousPanel?.close()
        presentAutomaticWorkbench()
        captureEngine.onError = { [weak self] message in
            guard self?.sessionEpoch == epoch else { return }
            self?.emergencyHideWarp(reason: "捕获中断：\(message)。Warp 覆盖层已安全隐藏。")
            self?.protoPie.reportCaptureInterrupted(message)
        }
        captureEngine.onNotice = { [weak self] message in
            guard self?.sessionEpoch == epoch else { return }
            self?.controlPanel?.setStatus(message, color: .systemOrange)
        }
        captureEngine.onPresentation = { [weak self, weak controlPanel] presentation in
            guard self?.sessionEpoch == epoch else { return }
            controlPanel?.updateCapturePresentation(presentation)
        }

        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            outputController.window.orderOut(nil)
            controlPanel.setStatus(
                "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 NIOWarpApp，然后退出并重新启动。",
                color: .systemOrange
            )
            NSApp.activate(ignoringOtherApps: true)
            controlPanel.bringToFront()
            return
        }

        captureStartupTask = Task { @MainActor [weak self, weak controlPanel] in
            guard let self else { return }
            do {
                try await captureEngine.start(
                    displayID: outputID,
                    pixelWidth: pixelWidth,
                    pixelHeight: pixelHeight,
                    sourceMode: configuration.capture.sourceMode,
                    minimumCoverage: configuration.capture.fullscreenCoverageThreshold
                )
                guard !Task.isCancelled, self.sessionEpoch == epoch else { return }
                self.protoPie.setPresentationCanvas(configuration.canvas)
                self.protoPie.setTargetDisplay(outputID)
                self.protoPie.startIfConfigured()
                controlPanel?.setStatus(
                    configuration.capture.sourceMode == .automaticFullscreenWindow
                        ? "自动跟随已启动：播放器进入全屏后会在约 1 秒内切为单窗口捕获。"
                        : "正在捕获外屏完整桌面；AA 区外纯黑，配置会自动保存。"
                )
                self.presentAutomaticWorkbench()
            } catch {
                guard !Task.isCancelled, self.sessionEpoch == epoch else { return }
                self.emergencyHideWarp(reason: "启动失败：\(error.localizedDescription)。Warp 覆盖层已安全隐藏。")
            }
        }
    }

    private func waitingForScreenMessage() -> String {
        let hasExternal = NSScreen.screens.contains { screen in
            guard let id = displayID(for: screen) else { return false }
            return CGDisplayIsBuiltin(id) == 0
        }
        return DisplaySessionPolicy.waitingMessage(hasExternalScreen: hasExternal)
    }

    private func showWaitingControlPanel(message: String) {
        outputController?.setWarpVisible(false)
        if let controlPanel, controlPanel.isWaitingForDisplay {
            if waitingMessage != message { controlPanel.setStatus(message, color: .systemOrange) }
            waitingMessage = message
            return
        }
        let preview = controlPanel?.configurationForOfflinePreview ?? configurationStore.offlineConfiguration()
        let physicalScreens = NSScreen.screens.filter { screen in
            guard let id = displayID(for: screen) else { return false }
            return !OwnedPresentationDisplay.isOwnedDisplay(id) && CGDisplayIsActive(id) != 0 && CGDisplayIsAsleep(id) == 0
        }
        let source = physicalScreens.first(where: { screen in
            guard let id = displayID(for: screen) else { return false }
            return CGDisplayIsBuiltin(id) != 0
        }) ?? physicalScreens.first
        let previousPanel = controlPanel
        let panel = ControlPanelController(
            renderer: nil, store: configurationStore, configuration: preview,
            sourceScreen: source, outputScreen: nil,
            setWarpVisible: { _ in }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in }, updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in }, protoPie: protoPie, mouseMapping: mouseMapping, playback: playback
        )
        if let previousPanel { panel.restoreWorkspace(from: previousPanel, sameDisplay: true) }
        controlPanel = panel
        waitingMessage = message
        panel.setStatus(message, color: .systemOrange)
        previousPanel?.close()
        NSApp.activate(ignoringOtherApps: true)
        panel.bringToFront()
        protoPie.setTargetDisplay(nil)
        protoPie.startIfConfigured()
    }

    private func restartSession(reason: String) {
        if playback.runtime.isActive { playback.pause(reason: reason) }
        mouseMapping.stop(reason: reason)
        protoPie.suspendForDisplayChange()
        sessionEpoch += 1
        captureStartupTask?.cancel()
        outputController?.setWarpVisible(false)
        if chooseScreens() == nil || displaysAsleep {
            showWaitingControlPanel(message: displaysAsleep ? "显示器已休眠，画面处理暂停；唤醒后自动恢复。" : waitingForScreenMessage())
        }
        guard !isReconfiguring else { return }
        isReconfiguring = true
        if controlPanel?.isWaitingForDisplay != true { emergencyHideWarp(reason: reason) }
        let previousStartup = captureStartupTask
        Task { @MainActor in
            await previousStartup?.value
            await captureEngine.stop()
            outputController?.window.close()
            outputController = nil
            outputDisplayState = nil
            outputWasDisconnected = false
            captureStartupTask = nil
            isReconfiguring = false
            startSession()
        }
    }

    private func scheduleStartupRetry() {
        startupRetryWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.outputController == nil, !self.isReconfiguring, !self.displaysAsleep else { return }
            self.startSession()
        }
        startupRetryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: workItem)
    }

    private func emergencyHideWarp(reason: String, userInitiated: Bool = false, notifyProtoPie: Bool = true) {
        mouseMapping.stop(reason: reason)
        if userInitiated, chooseScreens()?.source == nil { headlessWorkbenchRequested = true }
        outputController?.setWarpVisible(false)
        // Display/sleep recovery hides output temporarily; only an explicit user action pauses it.
        controlPanel?.updateWarpVisibilityState(false, notifyProtoPie: userInitiated && notifyProtoPie)
        controlPanel?.setStatus(reason, color: .systemOrange)
        if userInitiated || chooseScreens()?.source != nil || outputController == nil {
            NSApp.activate(ignoringOtherApps: true)
            controlPanel?.bringToFront()
            recoverVisiblePointer(forceWorkbench: userInitiated)
        }
    }

    @objc private func screenParametersChanged() {
        if preserveOutputForCurrentDisplays() { return }
        // Losing only the control screen must not invalidate capture callbacks or
        // clear the last rendered frame. Debounce transient desktop topology changes.
        if let state = outputDisplayState, CGDisplayIsActive(state.id) == 0 {
            // This stream may no longer be usable. Finish rebuilding even if the
            // same display returns before the debounce deadline.
            outputWasDisconnected = true
            outputController?.setWarpVisible(false)
        }
        if let screen = chooseScreens()?.output, let id = displayID(for: screen),
           CGDisplayIsActive(id) != 0, CGDisplayIsAsleep(id) == 0 { displaysAsleep = false }
        screenChangeWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, !self.preserveOutputForCurrentDisplays() else { return }
            self.restartSession(reason: "检测到外屏连接或分辨率变化，已隐藏覆盖层并重建输出。")
        }
        screenChangeWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: workItem)
    }

    @objc private func screensDidSleep() {
        // A lid event can remove/sleep the internal panel while the output stays awake.
        // NSScreen can briefly omit the output during topology changes; the cached
        // display ID still lets CoreGraphics report whether that output is awake.
        let candidateID = chooseScreens().flatMap { displayID(for: $0.output) }
        let outputIDs = [outputDisplayState?.id, candidateID].compactMap { $0 }
        if outputIDs.contains(where: { CGDisplayIsActive($0) != 0 && CGDisplayIsAsleep($0) == 0 }) {
            displaysAsleep = false
            if !preserveOutputForCurrentDisplays() { screenParametersChanged() }
            return
        }
        displaysAsleep = true
        startupRetryWorkItem?.cancel()
        screenChangeWorkItem?.cancel()
        restartSession(reason: "显示器已休眠，Warp 覆盖层已安全隐藏。")
    }

    @objc private func screensDidWake() {
        displaysAsleep = false
        if preserveOutputForCurrentDisplays() { return }
        restartSession(reason: "显示器已唤醒，正在重建 Warp 输出。")
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        playback.shutdown()
        presentationExit.stop()
        mouseMapping.stop(reason: "程序正在退出。")
        Task { @MainActor in
            await mouseMapping.finishClosing()
            protoPie.shutdown()
            captureStartupTask?.cancel()
            await protoPieReleaseTask?.value
            await captureEngine.stop()
            protoPie.finishShutdownPresentation()
            await playback.log.flush()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        playback.shutdown()
        mouseMapping.stop(reason: "程序正在退出。")
        protoPie.shutdown()
        sessionEpoch += 1
        captureStartupTask?.cancel()
        screenChangeWorkItem?.cancel()
        startupRetryWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        Task { await captureEngine.stop() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    @objc private func showWorkbench() {
        returnToWorkbench()
    }

    private func returnToWorkbench(notifyProtoPie: Bool = true, mouseReason: String = "已返回普通鼠标。") {
        if playback.runtime.isActive { playback.stop(reason: "已主动返回工作台") }
        // Cancel an asynchronous start too; a delayed activation must not take
        // focus back after the user has already requested the workbench.
        mouseMapping.stop(reason: mouseReason)
        if outputController != nil, chooseScreens()?.source == nil {
            emergencyHideWarp(reason: "已暂停演示以显示工作台；点击“重新显示校正画面”继续合盖演示。",
                              userInitiated: true, notifyProtoPie: notifyProtoPie)
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        controlPanel?.bringToFront()
        recoverVisiblePointer(forceWorkbench: true)
    }

    private func recoverVisiblePointer(forceWorkbench: Bool) {
        guard let point = VisiblePointerRecoveryRuntime.recoveryDestination(
            window: controlPanel?.window, lastVisiblePoint: lastVisiblePointer,
            forceWorkbench: forceWorkbench) else { return }
        if CGWarpMouseCursorPosition(point) == .success {
            lastVisiblePointer = point
            NSCursor.arrow.set()
        }
    }

    private func guardInvisiblePresentationScreen() {
        guard !displaysAsleep, let point = CGEvent(source: nil)?.location else { return }
        let screens = VisiblePointerRecoveryRuntime.screens()
        if VisiblePointerRecoveryPolicy.physicalScreens(screens).contains(where: { $0.quartzBounds.contains(point) }) {
            lastVisiblePointer = point
        } else if screens.contains(where: { $0.isOwned && $0.quartzBounds.contains(point) }) {
            // This display is a capture source, never an operator's desktop.
            // The guard also runs after an input/session failure.
            returnToWorkbench(mouseReason: "指针进入了不可见的播放器内容屏，已返回工作台。")
        }
    }

    private func configureMouseMapping() {
        mouseMapping.outputDiagnosticProvider = { [weak self] in
            guard let self else { return ["appAvailable": false] }
            var state: [String: Any] = ["outputExists": self.outputController != nil,
                "displayIDAvailable": self.outputDisplayState != nil]
            let captured = self.captureEngine.frameStore.snapshot()
            state["capture"] = self.captureEngine.frameStore.inputDiagnostic()
            state["captureSourceAvailable"] = captured?.source != nil
            if let output = self.outputController {
                state["warpVisible"] = output.isWarpVisible
                state["rendererRevision"] = output.renderer.meshRevision
                state["inputFrameAvailable"] = output.renderer.inputFrame != nil
                if let frame = output.renderer.inputFrame {
                    state["frameRevisionMatches"] = frame.revision == output.renderer.meshRevision
                    state["configurationMatches"] = frame.configuration == output.renderer.activeConfiguration
                    state["captureSourceMatches"] = captured?.source == frame.source
                }
            }
            return state
        }
        mouseMapping.sessionProvider = { [weak self] in
            guard let self, case .running = self.protoPie.state else { return nil }
            return self.protoPie.activeSession
        }
        mouseMapping.outputProvider = { [weak self] in
            guard let self, let output = self.outputController, output.isWarpVisible,
                  let id = self.outputDisplayState?.id, let frame = output.renderer.inputFrame,
                  frame.revision == output.renderer.meshRevision,
                  frame.configuration == output.renderer.activeConfiguration,
                  self.captureEngine.frameStore.snapshot()?.source == frame.source else { return nil }
            return MouseMappingOutput(window: output.window, cursor: output.mouseCursor, displayID: id,
                frame: frame, setInputEnabled: { [weak output] in output?.setMouseInputEnabled($0) })
        }
        mouseMapping.onReturnToWorkbench = { [weak self] in self?.showWorkbench() }
        mouseMapping.onPresentationTick = { [weak self] in
            self?.guardInvisiblePresentationScreen()
            self?.outputController?.publishPresentationDiagnostic()
        }
        presentationExit.shouldExit = { [weak self] in
            guard let self, let output = self.outputController, output.isWarpVisible,
                  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
                  let point = CGEvent(source: nil)?.location else { return false }
            if front == ProcessInfo.processInfo.processIdentifier {
                return output.window.isKeyWindow
            }
            guard front == self.protoPie.activeSession?.processID else { return false }
            let sourcePoint = VisiblePointerRecoveryRuntime.screens().contains { $0.isOwned && $0.quartzBounds.contains(point) }
            let outputPoint = self.outputDisplayState.map { CGDisplayBounds($0.id).contains(point) } ?? false
            return sourcePoint || outputPoint
        }
        presentationExit.onExit = { [weak self] in self?.showWorkbench() }
        _ = presentationExit.start()
        mouseMapping.monitorPresentation()
    }

    private func configurePlayback() {
        playback.prepare = { [weak self] item, reload in
            guard let self else { throw CancellationError() }
            try Task.checkCancellation()
            self.mouseMapping.stop(reason: "正在切换自动演示来源。")
            await self.mouseMapping.finishClosing()
            try Task.checkCancellation()
            let configuration = try item.configuration(inheriting: self.protoPie.saved)
            _ = try await self.protoPie.prepareForPlayback(configuration: configuration, reload: reload)
        }
        playback.cancelPreparation = { [weak self] in self?.protoPie.cancelPlaybackPreparation() }
        playback.bindInput = { [weak self] in
            guard let self else { throw CancellationError() }
            try await self.mouseMapping.beginAutomation()
        }
        playback.performAction = { [weak self] step in
            guard let self else { throw CancellationError() }
            try await self.mouseMapping.performAutomation(step)
        }
        playback.releaseInput = { [weak self] in await self?.mouseMapping.releaseAutomationInput() }
        playback.stopPresentation = { [weak self] in
            guard let self else { return }
            self.protoPie.finishPlaybackOwnership()
            self.protoPie.stop()
            self.returnToWorkbench(notifyProtoPie: false)
        }
        playback.healthSnapshot = { [weak self] in
            guard let self else { return [:] }
            var health = self.mouseMapping.automationDiagnostic
            health["captureActive"] = String(self.captureEngine.frameStore.snapshot() != nil)
            health["appVersion"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            if let output = self.outputController {
                let config = output.renderer.activeConfiguration
                health["canvasWidth"] = String(config.canvas.width)
                health["canvasHeight"] = String(config.canvas.height)
                let performance = output.renderer.performanceSnapshot()
                health["fps"] = String(performance.framesPerSecond)
                health["latencyMS"] = String(performance.averageGPUTimeMilliseconds)
            }
            if let id = self.outputDisplayState?.id { health["displayID"] = String(id) }
            let captured = self.captureEngine.frameStore.snapshot()
            health["frameAvailable"] = String(captured != nil)
            health["isVisible"] = String(self.outputController?.isWarpVisible == true)
            if let frame = self.outputController?.renderer.inputFrame {
                health["sourceMatches"] = String(captured?.source == frame.source)
            }
            var memory = task_vm_info_data_t()
            var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
            let result = withUnsafeMutablePointer(to: &memory) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
                }
            }
            if result == KERN_SUCCESS { health["memoryMB"] = String(Double(memory.phys_footprint) / 1_048_576) }
            return health
        }
        protoPie.onManualControl = { [weak self] in
            guard let self, self.playback.runtime.isActive else { return }
            self.playback.stop(reason: "已切换到手动播放器控制")
            self.protoPie.finishPlaybackOwnership()
        }
        mouseMapping.onAutomationUserActivity = { [weak self] in
            self?.playback.pause(reason: "检测到本机操作，自动演示已暂停；当前键鼠由你接管。")
        }
        mouseMapping.onAutomationFailure = { [weak self] reason in self?.playback.reportInterruption(reason) }
        mouseMapping.onAutomationExit = { [weak self] in self?.playback.stop(reason: "已按 Esc 退出自动演示") }
        playbackObserver = playback.observe { [weak self] in
            guard let self, !self.playback.runtime.isActive, self.protoPie.playbackManaged else { return }
            self.protoPie.finishPlaybackOwnership()
        }
    }

    private func configureProtoPie() {
        protoPie.onCapture = { [weak self] windowID, processID in
            guard let self, self.outputController != nil, !self.displaysAsleep else {
                throw ProtoPieError.unavailable("等待目标外屏和捕获权限就绪后重试。")
            }
            let epoch = self.sessionEpoch
            await self.protoPieReleaseTask?.value
            try Task.checkCancellation()
            guard self.sessionEpoch == epoch else { throw CancellationError() }
            try await self.captureEngine.pinPreviewWindow(windowID, processID: processID)
            guard self.sessionEpoch == epoch else { throw CancellationError() }
        }
        protoPie.onStop = { [weak self] in
            guard let self else { return }
            self.outputController?.setWarpVisible(false)
            self.controlPanel?.updateWarpVisibilityState(false, notifyProtoPie: false)
            let epoch = self.sessionEpoch
            self.protoPieReleaseTask = Task { @MainActor [weak self] in
                guard let self, self.sessionEpoch == epoch else { return }
                await self.captureEngine.releasePinnedPreview()
            }
        }
        protoPie.onSuspendOutput = { [weak self] in self?.outputController?.setWarpVisible(false) }
        protoPie.onResumeOutput = { [weak self] in self?.outputController?.setWarpVisible(true) }
        protoPie.onStateChange = { [weak self] state in
            guard let self else { return }
            switch state {
            case .running:
                self.hideWorkbenchOnOutputScreen()
                self.outputController?.setWarpVisible(true)
                self.controlPanel?.updateWarpVisibilityState(true, notifyProtoPie: false)
            case .paused:
                self.outputController?.setWarpVisible(false)
                self.controlPanel?.updateWarpVisibilityState(false, notifyProtoPie: false)
            case .failed(let reason):
                if self.protoPie.playbackManaged {
                    self.playback.reportInterruption(reason)
                    return
                }
                // A failed coordinator may notify again when paused. This is
                // its failure callback, so never feed a pause back into it.
                self.returnToWorkbench(notifyProtoPie: false)
                self.controlPanel?.setStatus("ProtoPie 联动：\(reason)", color: .systemOrange)
            default: break
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if controlPanel == nil { startSession() }
        showWorkbench()
        return false
    }

    private func presentAutomaticWorkbench() {
        guard chooseScreens()?.source != nil else {
            if !headlessWorkbenchRequested { controlPanel?.window?.orderOut(nil) }
            return
        }
        headlessWorkbenchRequested = false
        NSApp.activate(ignoringOtherApps: true)
        controlPanel?.bringToFront()
    }

    private func hideWorkbenchOnOutputScreen() {
        guard chooseScreens()?.source == nil else { return }
        headlessWorkbenchRequested = false
        controlPanel?.window?.orderOut(nil)
    }

    private func displayState(for screen: NSScreen) -> WarpOutputDisplayState? {
        guard let id = displayID(for: screen) else { return nil }
        let mode = CGDisplayCopyDisplayMode(id)
        return WarpOutputDisplayState(id: id,
            pixelWidth: mode?.pixelWidth ?? CGDisplayPixelsWide(id),
            pixelHeight: mode?.pixelHeight ?? CGDisplayPixelsHigh(id),
            scale: Double(screen.backingScaleFactor))
    }

    @discardableResult private func preserveOutputForCurrentDisplays() -> Bool {
        guard !isReconfiguring, !outputWasDisconnected, let outputController, let topology = chooseScreens(),
              let next = displayState(for: topology.output),
              DisplaySessionPolicy.canPreserveOutput(current: outputDisplayState, next: next,
                  isActive: CGDisplayIsActive(next.id) != 0, isAsleep: CGDisplayIsAsleep(next.id) != 0) else { return false }
        displaysAsleep = false
        screenChangeWorkItem?.cancel()
        startupRetryWorkItem?.cancel()
        let previousControlID = controlDisplayID
        controlDisplayID = topology.source.flatMap(displayID)
        // Origin can change when the built-in display disappears. Keep the same
        // renderer, stream, preview page and session epoch; relocate only the window.
        let originChanged = outputController.window.frame.origin != topology.output.frame.origin
        outputController.window.setFrame(topology.output.frame, display: true)
        if originChanged { mouseMapping.displayOriginChanged() }
        if outputController.isWarpVisible { outputController.restorePresentation() }
        if let control = topology.source {
            headlessWorkbenchRequested = false
            controlPanel?.fitWindow(to: control.visibleFrame)
            if previousControlID != controlDisplayID, !mouseMapping.isActive { controlPanel?.bringToFront() }
        } else if !headlessWorkbenchRequested {
            controlPanel?.window?.orderOut(nil)
        }
        return true
    }

    private func chooseScreens() -> (source: NSScreen?, output: NSScreen)? {
        let screens = NSScreen.screens
        let candidates = screens.compactMap { screen -> WarpScreenCandidate? in
            guard let id = displayID(for: screen), !OwnedPresentationDisplay.isOwnedDisplay(id) else { return nil }
            return WarpScreenCandidate(id: id, isBuiltIn: CGDisplayIsBuiltin(id) != 0, area: screen.frame.width * screen.frame.height)
        }
        let preferredControl = NSScreen.main.flatMap(displayID)
        guard let selection = DisplaySessionPolicy.selection(screens: candidates, preferredControlID: preferredControl,
                                                            preferredOutputID: outputDisplayState?.id),
              let output = screens.first(where: { displayID(for: $0) == selection.outputID }) else { return nil }
        let control = selection.controlID.flatMap { id in screens.first { displayID(for: $0) == id } }
        return (control, output)
    }

    private func displayID(for screen: NSScreen) -> CGDirectDisplayID? {
        screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    }

    private func displayProfileIdentifier(for displayID: CGDirectDisplayID) -> String {
        let vendor = CGDisplayVendorNumber(displayID)
        let model = CGDisplayModelNumber(displayID)
        let serial = CGDisplaySerialNumber(displayID)
        return "vendor-\(vendor)-model-\(model)-serial-\(serial)"
    }

}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let appDelegate = AppDelegate()
    application.delegate = appDelegate
    withExtendedLifetime(appDelegate) { application.run() }
}
