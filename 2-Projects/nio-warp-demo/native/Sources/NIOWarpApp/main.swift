import AppKit
import Carbon
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Metal
import MetalKit
import ScreenCaptureKit

private struct ShaderUniforms {
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
}

final class LatestFrameStore {
    private let lock = NSLock()
    private var pixelBuffer: CVPixelBuffer?

    func update(_ buffer: CVPixelBuffer) {
        lock.lock()
        pixelBuffer = buffer
        lock.unlock()
    }

    func latest() -> CVPixelBuffer? {
        lock.lock()
        defer { lock.unlock() }
        return pixelBuffer
    }

    func clear() {
        lock.lock()
        pixelBuffer = nil
        lock.unlock()
    }
}

private final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate {
    let frameStore = LatestFrameStore()
    private let queue = DispatchQueue(label: "com.mycc.nio-warp.capture", qos: .userInteractive)
    private var stream: SCStream?
    private let streamIdentityLock = NSLock()
    private var activeStreamIdentity: ObjectIdentifier?
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

    private func markActiveStream(_ stream: SCStream?) {
        streamIdentityLock.lock()
        activeStreamIdentity = stream.map(ObjectIdentifier.init)
        if stream == nil { frameStore.clear() }
        streamIdentityLock.unlock()
    }

    func stop() async {
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

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              let imageBuffer = sampleBuffer.imageBuffer else { return }
        streamIdentityLock.lock()
        defer { streamIdentityLock.unlock() }
        guard activeStreamIdentity == ObjectIdentifier(stream) else { return }
        frameStore.update(imageBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        streamIdentityLock.lock()
        let isCurrent = activeStreamIdentity == ObjectIdentifier(stream)
        streamIdentityLock.unlock()
        if isCurrent { emitError(error.localizedDescription) }
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
              let displayID,
              stream != nil else { return }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard !Task.isCancelled, sourceMode == .automaticFullscreenWindow, stream != nil else { return }
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
            guard sourceMode == .automaticFullscreenWindow else { return }
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

    private func streamConfiguration(width: Int, height: Int, singleWindow: Bool) -> SCStreamConfiguration {
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
            configuration.includeChildWindows = true
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

    init?(view: MTKView, frameStore: LatestFrameStore, configuration: WarpConfiguration) {
        guard let device = MTLCreateSystemDefaultDevice(),
              let commandQueue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.commandQueue = commandQueue
        self.frameStore = frameStore
        self.configuration = configuration

        let shaderSource = """
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

        float4 calibrationPattern(float2 uv, float2 gridScale, bool smoothEdges) {
            float2 gridUV = 0.5 + (uv - 0.5) * gridScale;
            float minorGrid = max(gridLine(gridUV.x, 0.02, 0.7, smoothEdges), gridLine(gridUV.y, 0.02, 0.7, smoothEdges));
            float majorGrid = max(gridLine(gridUV.x, 0.10, 1.0, smoothEdges), gridLine(gridUV.y, 0.10, 1.0, smoothEdges));
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
                float4 pattern = calibrationPattern(patternUV, uniforms.gridUVScale, smoothEdges);
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

        do {
            let library = try device.makeLibrary(source: shaderSource, options: nil)
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
        guard let pixelBuffer = frameStore.latest(),
              let descriptor = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor),
              let vertexBuffer,
              let indexBuffer,
              let textureCache else { return }

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
            gridUVScale: configuration.gridUVScale
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
        commandBuffer.addCompletedHandler { [performanceMonitor] completedBuffer in
            _ = cvTexture
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

    override var canBecomeKey: Bool { false }
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

private final class OutputController {
    let window: NSWindow
    let renderer: WarpRenderer
    private let aaBoundaryOverlay: AABoundaryOverlayView
    private let warpBoundaryOverlay: WarpBoundaryOverlayView

    init?(
        screen: NSScreen,
        pixelWidth: Int,
        pixelHeight: Int,
        frameStore: LatestFrameStore,
        configuration: WarpConfiguration
    ) {
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
            window.orderFrontRegardless()
        } else {
            window.orderOut(nil)
        }
    }

    func updateAABoundary(aaRect: NormalizedRect, visible: Bool) {
        aaBoundaryOverlay.update(aaRect: aaRect, visible: visible)
    }

    func updateWarpBoundary(configuration: WarpConfiguration, visible: Bool) {
        warpBoundaryOverlay.update(configuration: configuration, visible: visible)
    }
}

final class ControlPanelController: NSWindowController, NSTextFieldDelegate {
    private let renderer: WarpRenderer?
    private let store: ConfigurationStore
    private let presetStore = PresetStore()
    private let historyStore = ConfigurationHistoryStore()
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

    private let statusLabel = NSTextField(wrappingLabelWithString: "等待屏幕捕获权限…")
    private let globalStatusLabel = NSTextField(wrappingLabelWithString: "正在准备控制台…")
    private let configurationTabs = NSTabView()
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
    private let asymmetrySlider = NSSlider()
    private let tiltSlider = NSSlider()
    private let horizontalBendSlider = NSSlider()
    private let antiAliasingPicker = NSPopUpButton()
    private let antiAliasingEnabledButton = NSButton(checkboxWithTitle: "平滑线条边缘（抗锯齿）", target: nil, action: nil)
    private let automaticPerformanceButton = NSButton(checkboxWithTitle: "帧率不足时，自动降低采样档位保流畅", target: nil, action: nil)
    private let testPatternButton = NSButton(checkboxWithTitle: "显示标定网格、中心线和边界", target: nil, action: nil)
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
        presentWindow: Bool = true
    ) {
        self.renderer = renderer
        self.store = store
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
        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 790),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "NIO 全屏 Warp 标定控制台 · \(AppVersion.display)"
        if renderer == nil { panel.title += " · 等待外屏" }
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 600, height: 500)
        super.init(window: panel)
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
        if presentWindow { bringToFront() }
    }

    required init?(coder: NSCoder) { nil }

    deinit { performanceTimer?.invalidate() }

    private func buildInterface(sourceScreen: NSScreen?, outputScreen: NSScreen?) {
        guard let contentView = window?.contentView else { return }
        let header = NSStackView()
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 8
        header.translatesAutoresizingMaskIntoConstraints = false
        configurationTabs.translatesAutoresizingMaskIntoConstraints = false
        configurationTabs.tabViewType = .topTabsBezelBorder
        configurationTabs.font = .systemFont(ofSize: 13, weight: .medium)
        configurationTabs.setAccessibilityLabel("配置分类")
        contentView.addSubview(header)
        contentView.addSubview(configurationTabs)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 22),
            header.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -22),
            header.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 18),
            configurationTabs.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            configurationTabs.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
            configurationTabs.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            configurationTabs.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),
        ])
        let basicPage = makeTabPage(title: "基础配置", identifier: "basic")
        let opticalPage = makeTabPage(title: "光学标定", identifier: "optical")
        let settingsPage = makeTabPage(title: "属性设置", identifier: "settings")
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
        stack.addArrangedSubview(titleRow)
        globalStatusLabel.textColor = .secondaryLabelColor
        globalStatusLabel.font = .systemFont(ofSize: 12)
        globalStatusLabel.maximumNumberOfLines = 2
        globalStatusLabel.preferredMaxLayoutWidth = 550
        globalStatusLabel.heightAnchor.constraint(equalToConstant: 34).isActive = true
        globalStatusLabel.setAccessibilityIdentifier("nio-global-status")
        stack.addArrangedSubview(globalStatusLabel)
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
        let captureHint = NSTextField(wrappingLabelWithString: "自动模式会识别覆盖外屏 82% 以上并连续稳定的最大窗口；播放器退出全屏或窗口关闭后自动恢复整屏捕获。画面继续按“保持比例·铺满裁切”映射，不会压扁。")
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
        stack.addArrangedSubview(geometryPreviewPicker)
        geometryPreview.widthAnchor.constraint(equalToConstant: 490).isActive = true
        geometryPreview.heightAnchor.constraint(equalToConstant: 230).isActive = true
        geometryPreview.setAccessibilityLabel("画布几何预览：黄色是 AA，青色是曲面，灰色虚线是起点边界")
        stack.addArrangedSubview(geometryPreview)
        stack.addArrangedSubview(explanation("黄色＝AA；青色＝当前曲面；灰虚线＝起点。这里只预览几何，不包含播放器黑边或真实玻璃效果；小图自动缩放不影响外屏。"))
        canvasMeasurementLabel.preferredMaxLayoutWidth = 490
        canvasMeasurementLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(canvasMeasurementLabel)

        stack = opticalPage
        stack.addArrangedSubview(sectionTitle("3. 镜像"))
        horizontalMirrorButton.target = self
        horizontalMirrorButton.action = #selector(updateMirror)
        verticalMirrorButton.target = self
        verticalMirrorButton.action = #selector(updateMirror)
        stack.addArrangedSubview(buttonRow([horizontalMirrorButton, verticalMirrorButton]))

        stack = basicPage
        stack.addArrangedSubview(sectionTitle("4. 基础校畸变"))
        warpButton.target = self
        warpButton.action = #selector(toggleWarp)
        stack.addArrangedSubview(warpButton)
        inverseWarpTrendButton.target = self
        inverseWarpTrendButton.action = #selector(toggleWarpTrend)
        stack.addArrangedSubview(inverseWarpTrendButton)
        stack.addArrangedSubview(makeSlider(title: "Warp 强度", slider: strengthSlider, minimum: 0, maximum: 1.5, action: #selector(updateStrength)))
        stack.addArrangedSubview(makeSlider(title: "上下弧度", slider: archSlider, minimum: 0, maximum: 0.2, action: #selector(updateArch)))
        stack.addArrangedSubview(makeSlider(title: "垂直压缩", slider: verticalScaleSlider, minimum: 0.6, maximum: 1.1, action: #selector(updateVerticalScale)))
        stack.addArrangedSubview(makeSlider(title: "左右不对称", slider: asymmetrySlider, minimum: -0.2, maximum: 0.2, action: #selector(updateAsymmetry)))
        stack.addArrangedSubview(makeSlider(title: "整体倾斜", slider: tiltSlider, minimum: -0.12, maximum: 0.12, action: #selector(updateTilt)))
        stack.addArrangedSubview(makeSlider(title: "水平弯曲", slider: horizontalBendSlider, minimum: -0.08, maximum: 0.08, action: #selector(updateHorizontalBend)))

        stack = opticalPage
        stack.addArrangedSubview(sectionTitle("5. 多项式增量"))
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
        stack.addArrangedSubview(buttonRow([rawCalibrationButton, antiAliasingComparisonButton]))
        performanceLabel.textColor = .secondaryLabelColor
        performanceLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(performanceLabel)

        stack = settingsPage
        stack.addArrangedSubview(sectionTitle("7. 预设与版本回退"))
        presetNameField.placeholderString = "例如：玻璃 A / 驾驶位"
        presetNameField.widthAnchor.constraint(equalToConstant: 220).isActive = true
        stack.addArrangedSubview(labeledRow("预设名称", presetNameField))
        presetPicker.widthAnchor.constraint(equalToConstant: 220).isActive = true
        stack.addArrangedSubview(labeledRow("已有预设", presetPicker))
        stack.addArrangedSubview(buttonRow([
            makeButton("保存预设", action: #selector(savePreset)),
            makeButton("应用预设", action: #selector(applyPreset)),
            makeButton("删除预设", action: #selector(deletePreset)),
        ]))
        historyButton.target = self
        historyButton.action = #selector(rollbackConfiguration)
        stack.addArrangedSubview(historyButton)

        stack.addArrangedSubview(sectionTitle("8. 安全控制与配置文件"))
        pauseWarpButton.target = self
        pauseWarpButton.action = #selector(toggleWarpVisibility)
        stack.addArrangedSubview(buttonRow([
            pauseWarpButton,
            makeButton("导入参数文件", action: #selector(importConfiguration)),
            makeButton("导出参数备份", action: #selector(exportConfiguration)),
            makeButton("重置全部参数", action: #selector(resetConfiguration)),
        ]))

        statusLabel.textColor = .systemOrange
        statusLabel.maximumNumberOfLines = 5
        statusLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(statusLabel)

        let hint = NSTextField(wrappingLabelWithString: "紧急恢复：按 ⌃⌥⌘Esc 可立即隐藏外屏覆盖层。当前是视觉接管，Warp 后的视觉坐标尚未做输入逆映射。")
        hint.preferredMaxLayoutWidth = 490
        hint.textColor = .secondaryLabelColor
        stack.addArrangedSubview(hint)
        stack.addArrangedSubview(makeButton("退出程序，恢复原始桌面", action: #selector(NSApplication.terminate(_:)), target: NSApp))
        let checkboxHelp: [(NSButton, String)] = [
            (horizontalMirrorButton, "左右对调内容，AA 和曲面形状不变；标定网格也跟随翻转。"),
            (verticalMirrorButton, "上下对调内容，AA 和曲面形状不变；标定网格也跟随翻转。"),
            (warpButton, "使用下方滑杆的弧度、倾斜等设置；关闭不会删除数值，多项式仍单独控制。"),
            (inverseWarpTrendButton, "反转基础校正与多项式的位移方向，用于预抵消玻璃反射弯曲；需要实拍验证。"),
            (polynomialButton, "只开关多项式，不清空系数；翻折参数会拒绝应用。"),
            (antiAliasingEnabledButton, "平滑细线和文字边缘，关闭使用点采样；不会改变几何形状。"),
            (automaticPerformanceButton, "运行时降低采样档位以保护流畅度，不改写保存的画质选择。"),
            (testPatternButton, "用带方向角标的网格替代桌面，检查曲线和镜像；关闭后恢复桌面或视频。"),
        ]
        checkboxHelp.forEach { button, text in button.toolTip = text; button.setAccessibilityHelp(text) }
    }

    private func makeTabPage(title: String, identifier: String) -> NSStackView {
        let scrollView = NSScrollView(frame: .zero)
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
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 22, bottom: 22, right: 22)
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

    private func screenName(_ screen: NSScreen) -> String {
        "\(screen.localizedName) · \(Int(screen.frame.width))×\(Int(screen.frame.height)) pt"
    }

    private func sectionTitle(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 14, weight: .bold)
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
            "terminate:": "退出 NIO Warp，移除外屏覆盖层，显示原始桌面。",
        ]
        button.toolTip = help[NSStringFromSelector(action)] ?? title
        button.setAccessibilityHelp(button.toolTip)
        return button
    }

    private func explanation(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = 490
        return label
    }

    private func buttonRow(_ views: [NSView]) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    private func labeledRow(_ title: String, _ view: NSView) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        label.widthAnchor.constraint(equalToConstant: 92).isActive = true
        let row = NSStackView(views: [label, view])
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    private func fieldGrid(_ fields: [(String, NSView)]) -> NSGridView {
        let rows = fields.chunked(into: 2).map { group -> [NSView] in
            var views = [NSView]()
            for item in group {
                let label = NSTextField(labelWithString: item.0)
                views.append(label)
                views.append(item.1)
            }
            while views.count < 4 { views.append(NSView()) }
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

        let row = NSStackView(views: [minus, field, plus])
        row.orientation = .horizontal
        row.spacing = 4
        return row
    }

    private func makeSlider(title: String, slider: NSSlider, minimum: Double, maximum: Double, action: Selector) -> NSView {
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
        slider.widthAnchor.constraint(equalToConstant: 490).isActive = true
        container.addArrangedSubview(label)
        container.addArrangedSubview(slider)
        return container
    }

    private func refreshControls() {
        let aa = configuration.aaRect.sanitized()
        aaXField.stringValue = String(Int((aa.x * Double(displayWidth)).rounded()))
        aaYField.stringValue = String(Int((aa.y * Double(displayHeight)).rounded()))
        aaWidthField.stringValue = String(Int((aa.width * Double(displayWidth)).rounded()))
        aaHeightField.stringValue = String(Int((aa.height * Double(displayHeight)).rounded()))
        canvasWidthField.stringValue = String(configuration.canvas.width)
        canvasHeightField.stringValue = String(configuration.canvas.height)
        cropHorizontalSlider.doubleValue = configuration.cropAnchor.horizontal
        cropVerticalSlider.doubleValue = configuration.cropAnchor.vertical
        horizontalMirrorButton.state = configuration.mirror.horizontal ? .on : .off
        verticalMirrorButton.state = configuration.mirror.vertical ? .on : .off
        warpButton.state = configuration.manual.enabled ? .on : .off
        inverseWarpTrendButton.state = configuration.warpTrend == .inverse ? .on : .off
        polynomialButton.state = configuration.polynomial.enabled ? .on : .off
        strengthSlider.doubleValue = configuration.manual.strength
        archSlider.doubleValue = configuration.manual.arch
        verticalScaleSlider.doubleValue = configuration.manual.verticalScale
        asymmetrySlider.doubleValue = configuration.manual.asymmetry
        tiltSlider.doubleValue = configuration.manual.tilt
        horizontalBendSlider.doubleValue = configuration.manual.horizontalBend
        contentModePicker.selectItem(at: ContentMode.allCases.firstIndex(of: configuration.contentMode) ?? 0)
        captureSourcePicker.selectItem(at: CaptureSourceMode.allCases.firstIndex(of: configuration.capture.sourceMode) ?? 0)
        antiAliasingEnabledButton.state = configuration.render.antiAliasingEnabled ? .on : .off
        antiAliasingPicker.selectItem(at: AntiAliasingMode.enabledCases.firstIndex(of: configuration.render.antiAliasing) ?? 0)
        antiAliasingPicker.isEnabled = configuration.render.antiAliasingEnabled
        automaticPerformanceButton.isEnabled = configuration.render.antiAliasingEnabled
        automaticPerformanceButton.state = configuration.render.automaticPerformanceFallback ? .on : .off
        testPatternButton.state = configuration.render.testPattern == .calibrationGrid ? .on : .off
        aaBoundaryButton.state = configuration.render.showAABoundary ? .on : .off
        extendedWarpButton.state = configuration.extendedWarpEnabled ? .on : .off
        warpBoundaryButton.state = configuration.render.showWarpBoundary ? .on : .off
        pauseWarpButton.title = isWarpVisible() ? "暂时显示原始桌面" : "重新显示校正画面"
        pauseWarpButton.toolTip = "只隐藏或恢复覆盖层，不清空任何参数；与重置参数不同。"
        historyButton.title = "撤销上一次设置（\(historyStore.count)）"
        historyButton.toolTip = "恢复最近一次修改前的参数，包括当时的画布起点；不是回退软件版本。"
        historyButton.isEnabled = historyStore.count > 0
        orderPicker.selectItem(at: configuration.polynomial.order - 2)
        rebuildTermPicker()
        refreshContentMappingStatus()
        refreshRuntimePreviewControls()
        refreshCanvasGeometry()
        if isWaitingForDisplay { configureWaitingControls() }
    }

    private func configureWaitingControls() {
        func disableEditing(in view: NSView) {
            for child in view.subviews {
                if let field = child as? NSTextField {
                    if field.isEditable { field.isEnabled = false }
                } else if let control = child as? NSControl {
                    let canUseOffline = control === geometryPreviewPicker
                        || control.action == #selector(exportConfiguration)
                        || control.action == #selector(NSApplication.terminate(_:))
                    control.isEnabled = canUseOffline
                }
                disableEditing(in: child)
            }
        }
        tabPageDocuments.forEach { disableEditing(in: $0) }
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
        lastAppliedConfiguration = configuration
        historyButton.title = "撤销上一次设置（\(historyStore.count)）"
        historyButton.isEnabled = historyStore.count > 0
        let color: NSColor = validation.isValid ? .systemGreen : .systemRed
        setStatus("\(message)；\(validation.summary)", color: color)
        refreshRuntimePreviewControls()
        refreshContentMappingStatus()
        refreshCanvasGeometry()
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
    }

    private func refreshCanvasGeometry() {
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
        guard let renderer else { return }
        let preview = previewConfiguration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        let validation = renderer.updateConfiguration(preview)
        updateWarpBoundary(preview, preview.render.showWarpBoundary)
        refreshCanvasGeometry()
        refreshRuntimePreviewControls()
        let color: NSColor = validation.isValid ? .systemOrange : .systemRed
        setStatus("\(message)；临时预览不会保存配置或增加历史。\n\(validation.summary)", color: color)
    }

    private func leaveRuntimePreview(message: String = "已返回校正状态") {
        guard let renderer else { return }
        runtimePreviewMode = .normal
        runtimePreviewReturnMode = .normal
        let validation = renderer.updateConfiguration(configuration)
        updateWarpBoundary(configuration, configuration.render.showWarpBoundary)
        refreshRuntimePreviewControls()
        refreshCanvasGeometry()
        let color: NSColor = validation.isValid ? .systemGreen : .systemRed
        setStatus("\(message)；\(validation.summary)", color: color)
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
        window.orderFrontRegardless()
        window.makeKey()
    }

    @objc private func applyAAFields() {
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

    func updateWarpVisibilityState(_ visible: Bool) {
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
    @objc private func updateVerticalScale(_ sender: NSSlider) { configuration.manual.verticalScale = sender.doubleValue; applyConfiguration("垂直压缩已更新") }
    @objc private func updateAsymmetry(_ sender: NSSlider) { configuration.manual.asymmetry = sender.doubleValue; applyConfiguration("左右不对称已更新") }
    @objc private func updateTilt(_ sender: NSSlider) { configuration.manual.tilt = sender.doubleValue; applyConfiguration("整体倾斜已更新") }
    @objc private func updateHorizontalBend(_ sender: NSSlider) { configuration.manual.horizontalBend = sender.doubleValue; applyConfiguration("水平弯曲已更新") }

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
        }
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

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let captureEngine = CaptureEngine()
    private let configurationStore = ConfigurationStore()
    private var outputController: OutputController?
    private var controlPanel: ControlPanelController?
    private var emergencyHotKey: GlobalHotKey?
    private var isReconfiguring = false
    private var screenChangeWorkItem: DispatchWorkItem?
    private var startupRetryWorkItem: DispatchWorkItem?
    private var captureStartupTask: Task<Void, Never>?
    private var sessionEpoch = 0
    private var waitingMessage: String?
    private var displaysAsleep = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(AppPresentationPolicy.activationPolicy)
        emergencyHotKey = GlobalHotKey(keyCode: UInt32(kVK_Escape), modifiers: UInt32(controlKey | cmdKey | optionKey)) { [weak self] in
            self?.emergencyHideWarp(reason: "已通过 ⌃⌥⌘Esc 紧急隐藏 Warp 覆盖层。")
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification,
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
        let previousPanel = controlPanel
        let controlPanel = ControlPanelController(
            renderer: outputController.renderer,
            store: configurationStore,
            configuration: configuration,
            sourceScreen: topology.source,
            outputScreen: topology.output,
            setWarpVisible: { [weak outputController] visible in outputController?.setWarpVisible(visible) },
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
            }
        )
        self.controlPanel = controlPanel
        waitingMessage = nil
        previousPanel?.close()
        NSApp.activate(ignoringOtherApps: true)
        controlPanel.bringToFront()
        captureEngine.onError = { [weak self] message in
            guard self?.sessionEpoch == epoch else { return }
            self?.emergencyHideWarp(reason: "捕获中断：\(message)。Warp 覆盖层已安全隐藏。")
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
                controlPanel?.setStatus(
                    configuration.capture.sourceMode == .automaticFullscreenWindow
                        ? "自动跟随已启动：播放器进入全屏后会在约 1 秒内切为单窗口捕获。"
                        : "正在捕获外屏完整桌面；AA 区外纯黑，配置会自动保存。"
                )
                NSApp.activate(ignoringOtherApps: true)
                controlPanel?.bringToFront()
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
        let source = NSScreen.screens.first(where: { screen in
            guard let id = displayID(for: screen) else { return false }
            return CGDisplayIsBuiltin(id) != 0
        }) ?? NSScreen.main ?? NSScreen.screens.first
        let previousPanel = controlPanel
        let panel = ControlPanelController(
            renderer: nil, store: configurationStore, configuration: preview,
            sourceScreen: source, outputScreen: nil,
            setWarpVisible: { _ in }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in }, updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in }
        )
        controlPanel = panel
        waitingMessage = message
        panel.setStatus(message, color: .systemOrange)
        previousPanel?.close()
        NSApp.activate(ignoringOtherApps: true)
        panel.bringToFront()
    }

    private func restartSession(reason: String) {
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

    private func emergencyHideWarp(reason: String) {
        outputController?.setWarpVisible(false)
        controlPanel?.updateWarpVisibilityState(false)
        controlPanel?.setStatus(reason, color: .systemOrange)
        NSApp.activate(ignoringOtherApps: true)
        controlPanel?.bringToFront()
    }

    @objc private func screenParametersChanged() {
        sessionEpoch += 1
        captureStartupTask?.cancel()
        outputController?.setWarpVisible(false)
        if chooseScreens() == nil { showWaitingControlPanel(message: waitingForScreenMessage()) }
        screenChangeWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.restartSession(reason: "检测到外屏连接或分辨率变化，已隐藏覆盖层并重建输出。")
        }
        screenChangeWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: workItem)
    }

    @objc private func screensDidSleep() {
        displaysAsleep = true
        startupRetryWorkItem?.cancel()
        screenChangeWorkItem?.cancel()
        restartSession(reason: "显示器已休眠，Warp 覆盖层已安全隐藏。")
    }

    @objc private func screensDidWake() {
        displaysAsleep = false
        restartSession(reason: "显示器已唤醒，正在重建 Warp 输出。")
    }

    func applicationWillTerminate(_ notification: Notification) {
        sessionEpoch += 1
        captureStartupTask?.cancel()
        screenChangeWorkItem?.cancel()
        startupRetryWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        Task { await captureEngine.stop() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        DisplaySessionPolicy.shouldTerminateAfterWindowClose(
            isReconfiguring: isReconfiguring,
            controlWindowVisible: controlPanel?.window?.isVisible ?? false,
            controlWindowMiniaturized: controlPanel?.window?.isMiniaturized ?? false
        )
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if controlPanel == nil { startSession() }
        NSApp.activate(ignoringOtherApps: true)
        controlPanel?.bringToFront()
        return false
    }

    private func chooseScreens() -> (source: NSScreen, output: NSScreen)? {
        let screens = NSScreen.screens
        let candidates = screens.compactMap { screen -> WarpScreenCandidate? in
            guard let id = displayID(for: screen) else { return nil }
            return WarpScreenCandidate(id: id, isBuiltIn: CGDisplayIsBuiltin(id) != 0, area: screen.frame.width * screen.frame.height)
        }
        let preferredControl = NSScreen.main.flatMap(displayID)
        guard let selection = DisplaySessionPolicy.selection(screens: candidates, preferredControlID: preferredControl),
              let control = screens.first(where: { displayID(for: $0) == selection.controlID }),
              let output = screens.first(where: { displayID(for: $0) == selection.outputID }) else { return nil }
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

let application = NSApplication.shared
private let appDelegate = AppDelegate()
application.delegate = appDelegate
application.run()
