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
}

private final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate {
    let frameStore = LatestFrameStore()
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
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw NSError(domain: "NIOWarp", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法找到源显示器"])
        }
        let filter = displayFilter(content: content, display: display)
        let configuration = streamConfiguration(width: pixelWidth, height: pixelHeight, singleWindow: false)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
        emitPresentation(
            sourceMode == .automaticFullscreenWindow
                ? .waitingForFullscreenWindow
                : .entireDisplay(width: pixelWidth, height: pixelHeight)
        )
        if sourceMode == .automaticFullscreenWindow { startMonitoring() }
    }

    func stop() async {
        monitorTask?.cancel()
        monitorTask = nil
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
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
        frameStore.update(imageBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            self?.onError?(error.localizedDescription)
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
              let displayID,
              stream != nil else { return }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard sourceMode == .automaticFullscreenWindow, stream != nil else { return }
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
        DispatchQueue.main.async { [weak self] in self?.onPresentation?(presentation) }
    }

    private func emitError(_ message: String) {
        DispatchQueue.main.async { [weak self] in self?.onError?(message) }
    }

    private func emitNotice(_ message: String) {
        DispatchQueue.main.async { [weak self] in self?.onNotice?(message) }
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

        float4 calibrationPattern(float2 uv, bool smoothEdges) {
            float minorGrid = max(gridLine(uv.x, 0.02, 0.7, smoothEdges), gridLine(uv.y, 0.02, 0.7, smoothEdges));
            float majorGrid = max(gridLine(uv.x, 0.10, 1.0, smoothEdges), gridLine(uv.y, 0.10, 1.0, smoothEdges));
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
                float4 pattern = calibrationPattern(patternUV, smoothEdges);
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
        self.configuration = configuration
        runtimeAntiAliasingOverride = nil
        rebuildMesh()
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
        rebuildMesh()
        return true
    }

    private func rebuildMesh() {
        let dimensions: (Int, Int)
        switch effectiveAntiAliasingMode {
        case .off: dimensions = (96, 40)
        case .performance: dimensions = (128, 48)
        case .quality: dimensions = (192, 72)
        }
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.0, rows: dimensions.1)
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
            canvasAspect: configuration.canvas.aspect,
            contentMode: configuration.contentMode.shaderValue,
            mirrorFlags: mirrorFlags,
            cropAnchor: SIMD2<Float>(
                Float(configuration.cropAnchor.horizontal),
                Float(configuration.cropAnchor.vertical)
            ),
            sourceTexelSize: SIMD2<Float>(1 / Float(max(width, 1)), 1 / Float(max(height, 1))),
            antiAliasingMode: effectiveAntiAliasingMode.shaderValue,
            testPatternMode: configuration.render.testPattern.shaderValue
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

private final class OutputWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
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
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.level = .screenSaver
        window.ignoresMouseEvents = true
        window.hidesOnDeactivate = false

        let metalView = MTKView(frame: NSRect(origin: .zero, size: screen.frame.size))
        metalView.autoresizingMask = [.width, .height]
        metalView.autoResizeDrawable = false
        metalView.drawableSize = CGSize(width: pixelWidth, height: pixelHeight)
        guard let renderer = WarpRenderer(view: metalView, frameStore: frameStore, configuration: configuration) else { return nil }
        metalView.delegate = renderer
        window.contentView = metalView
        window.setFrame(screen.frame, display: true)
        window.orderFrontRegardless()

        self.window = window
        self.renderer = renderer
    }

    var isWarpVisible: Bool { window.isVisible }

    func setWarpVisible(_ visible: Bool) {
        if visible {
            window.orderFrontRegardless()
        } else {
            window.orderOut(nil)
        }
    }
}

private final class ControlPanelController: NSWindowController, NSTextFieldDelegate {
    private let renderer: WarpRenderer
    private let store: ConfigurationStore
    private let presetStore = PresetStore()
    private let historyStore = ConfigurationHistoryStore()
    private let displayWidth: Int
    private let displayHeight: Int
    private let setWarpVisible: (Bool) -> Void
    private let isWarpVisible: () -> Bool
    private let applyCaptureConfiguration: (CaptureConfiguration) -> Void
    private var configuration: WarpConfiguration
    private var lastAppliedConfiguration: WarpConfiguration
    private var performanceTimer: Timer?
    private var presets = [WarpPreset]()
    private var runtimePreviewMode = RuntimePreviewMode.normal
    private var runtimePreviewReturnMode = RuntimePreviewMode.normal
    private var captureSourceWidth: Int
    private var captureSourceHeight: Int

    private let statusLabel = NSTextField(wrappingLabelWithString: "等待屏幕捕获权限…")
    private let captureSourcePicker = NSPopUpButton()
    private let capturePresentationLabel = NSTextField(wrappingLabelWithString: "当前捕获：初始化中…")
    private let aaXField = NSTextField()
    private let aaYField = NSTextField()
    private let aaWidthField = NSTextField()
    private let aaHeightField = NSTextField()
    private let canvasWidthField = NSTextField()
    private let canvasHeightField = NSTextField()
    private let cropHorizontalSlider = NSSlider()
    private let cropVerticalSlider = NSSlider()
    private let contentMappingLabel = NSTextField(wrappingLabelWithString: "内容映射计算中…")
    private let horizontalMirrorButton = NSButton(checkboxWithTitle: "水平翻转", target: nil, action: nil)
    private let verticalMirrorButton = NSButton(checkboxWithTitle: "垂直翻转", target: nil, action: nil)
    private let warpButton = NSButton(checkboxWithTitle: "启用基础 Warp", target: nil, action: nil)
    private let inverseWarpTrendButton = NSButton(checkboxWithTitle: "反向预畸变趋势（屏幕中凹两侧翘）", target: nil, action: nil)
    private let polynomialButton = NSButton(checkboxWithTitle: "启用多项式增量", target: nil, action: nil)
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
    private let antiAliasingEnabledButton = NSButton(checkboxWithTitle: "启用抗锯齿", target: nil, action: nil)
    private let automaticPerformanceButton = NSButton(checkboxWithTitle: "性能不足时自动降级", target: nil, action: nil)
    private let testPatternButton = NSButton(checkboxWithTitle: "显示标定网格、中心线和边界", target: nil, action: nil)
    private let rawCalibrationButton = NSButton(title: "一键无畸变标定", target: nil, action: nil)
    private let antiAliasingComparisonButton = NSButton(title: "抗锯齿 A/B 对比", target: nil, action: nil)
    private let performanceLabel = NSTextField(wrappingLabelWithString: "性能采样中…")
    private let pauseWarpButton = NSButton(title: "暂停 Warp", target: nil, action: nil)
    private let presetNameField = NSTextField()
    private let presetPicker = NSPopUpButton()
    private let historyButton = NSButton(title: "回退上一个版本", target: nil, action: nil)

    init(
        renderer: WarpRenderer,
        store: ConfigurationStore,
        configuration: WarpConfiguration,
        sourceScreen: NSScreen,
        outputScreen: NSScreen,
        setWarpVisible: @escaping (Bool) -> Void,
        isWarpVisible: @escaping () -> Bool,
        applyCaptureConfiguration: @escaping (CaptureConfiguration) -> Void
    ) {
        self.renderer = renderer
        self.store = store
        self.configuration = configuration
        lastAppliedConfiguration = configuration
        self.setWarpVisible = setWarpVisible
        self.isWarpVisible = isWarpVisible
        self.applyCaptureConfiguration = applyCaptureConfiguration
        displayWidth = configuration.displayPixelWidth
        displayHeight = configuration.displayPixelHeight
        captureSourceWidth = configuration.displayPixelWidth
        captureSourceHeight = configuration.displayPixelHeight
        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 790),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "NIO 全屏 Warp 标定控制台 · \(AppVersion.display)"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        super.init(window: panel)
        buildInterface(sourceScreen: sourceScreen, outputScreen: outputScreen)
        refreshControls()
        refreshPresets()
        startPerformanceMonitoring()
        let visibleFrame = sourceScreen.visibleFrame
        let origin = NSPoint(
            x: visibleFrame.midX - panel.frame.width * 0.5,
            y: visibleFrame.midY - panel.frame.height * 0.5
        )
        panel.setFrameOrigin(origin)
        bringToFront()
    }

    required init?(coder: NSCoder) { nil }

    deinit { performanceTimer?.invalidate() }

    private func buildInterface(sourceScreen: NSScreen, outputScreen: NSScreen) {
        guard let contentView = window?.contentView else { return }
        let scrollView = NSScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        contentView.addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: contentView.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])

        let documentView = FlippedView()
        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView
        documentView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor).isActive = true

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 22, right: 22)
        stack.translatesAutoresizingMaskIntoConstraints = false
        documentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor),
            stack.topAnchor.constraint(equalTo: documentView.topAnchor),
            stack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor),
        ])

        let titleRow = NSStackView()
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 10
        let title = NSTextField(labelWithString: "外屏桌面 → 逻辑画布 → 预畸变 → 矩形 AA 区")
        title.font = .systemFont(ofSize: 18, weight: .bold)
        let version = NSTextField(labelWithString: AppVersion.display)
        version.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
        version.textColor = .secondaryLabelColor
        version.toolTip = "当前运行版本"
        titleRow.addArrangedSubview(title)
        titleRow.addArrangedSubview(version)
        stack.addArrangedSubview(titleRow)
        let topology = NSTextField(wrappingLabelWithString: "控制台：\(screenName(sourceScreen))\n捕获与输出：\(screenName(outputScreen)) · \(displayWidth)×\(displayHeight) px\nAA 区外始终纯黑；多项式定义为逻辑画布到物理 AA 区的增量映射。")
        topology.textColor = .secondaryLabelColor
        stack.addArrangedSubview(topology)

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

        stack.addArrangedSubview(sectionTitle("1. 矩形 AA 区（物理屏像素）"))
        stack.addArrangedSubview(fieldGrid([
            ("X", numericField(aaXField, target: .aaX, decimal: false)),
            ("Y", numericField(aaYField, target: .aaY, decimal: false)),
            ("宽", numericField(aaWidthField, target: .aaWidth, decimal: false)),
            ("高", numericField(aaHeightField, target: .aaHeight, decimal: false)),
        ]))
        stack.addArrangedSubview(buttonRow([
            makeButton("保存并应用 AA 区", action: #selector(applyAAFields)),
            makeButton("居中 88%×48%", action: #selector(centerAA)),
            makeButton("全屏 AA", action: #selector(fullAA)),
        ]))

        stack.addArrangedSubview(sectionTitle("2. 逻辑画布"))
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
        stack.addArrangedSubview(makeButton("保存并应用画布尺寸", action: #selector(applyCanvasFields)))

        stack.addArrangedSubview(sectionTitle("3. 镜像"))
        horizontalMirrorButton.target = self
        horizontalMirrorButton.action = #selector(updateMirror)
        verticalMirrorButton.target = self
        verticalMirrorButton.action = #selector(updateMirror)
        stack.addArrangedSubview(buttonRow([horizontalMirrorButton, verticalMirrorButton]))

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
            makeButton("应用当前系数", action: #selector(applyPolynomialCoefficients)),
            makeButton("全部系数清零", action: #selector(clearPolynomial)),
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
            makeButton("导入 JSON", action: #selector(importConfiguration)),
            makeButton("导出 JSON", action: #selector(exportConfiguration)),
            makeButton("恢复默认", action: #selector(resetConfiguration)),
        ]))

        statusLabel.textColor = .systemOrange
        statusLabel.maximumNumberOfLines = 5
        statusLabel.preferredMaxLayoutWidth = 500
        stack.addArrangedSubview(statusLabel)

        let hint = NSTextField(wrappingLabelWithString: "紧急恢复：按 ⌃⌥⌘Esc 可立即隐藏外屏覆盖层。当前是视觉接管，Warp 后的视觉坐标尚未做输入逆映射。")
        hint.textColor = .secondaryLabelColor
        stack.addArrangedSubview(hint)
        stack.addArrangedSubview(makeButton("退出 Warp", action: #selector(NSApplication.terminate(_:)), target: NSApp))
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
        NSButton(title: title, target: target ?? self, action: action)
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
        pauseWarpButton.title = isWarpVisible() ? "暂停 Warp" : "恢复 Warp"
        historyButton.title = "回退上一个版本（\(historyStore.count)）"
        historyButton.isEnabled = historyStore.count > 0
        orderPicker.selectItem(at: configuration.polynomial.order - 2)
        rebuildTermPicker()
        refreshContentMappingStatus()
        refreshRuntimePreviewControls()
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
        runtimePreviewMode = .normal
        runtimePreviewReturnMode = .normal
        configuration = configuration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        if recordHistory, configuration != lastAppliedConfiguration {
            historyStore.record(lastAppliedConfiguration, reason: message)
        }
        store.save(configuration)
        let validation = renderer.updateConfiguration(configuration)
        if configuration.capture != lastAppliedConfiguration.capture {
            applyCaptureConfiguration(configuration.capture)
        }
        lastAppliedConfiguration = configuration
        historyButton.title = "回退上一个版本（\(historyStore.count)）"
        historyButton.isEnabled = historyStore.count > 0
        let color: NSColor = validation.isValid ? .systemGreen : .systemRed
        setStatus("\(message)；\(validation.summary)", color: color)
        refreshRuntimePreviewControls()
        refreshContentMappingStatus()
    }

    private func refreshContentMappingStatus(sourceWidth: Int? = nil, sourceHeight: Int? = nil) {
        if let sourceWidth { captureSourceWidth = sourceWidth }
        if let sourceHeight { captureSourceHeight = sourceHeight }
        let effectiveSourceWidth = captureSourceWidth
        let effectiveSourceHeight = captureSourceHeight
        let mapping = ContentMappingMath.mapping(
            sourceWidth: Float(effectiveSourceWidth),
            sourceHeight: Float(effectiveSourceHeight),
            targetWidth: Float(configuration.canvas.width),
            targetHeight: Float(configuration.canvas.height),
            mode: configuration.contentMode,
            anchor: configuration.cropAnchor
        )
        let cropX = Int((mapping.cropFraction.x * Float(effectiveSourceWidth)).rounded())
        let cropY = Int((mapping.cropFraction.y * Float(effectiveSourceHeight)).rounded())
        let warning = configuration.contentMode == .stretch ? " ⚠️ 拉伸会改变画面比例" : ""
        contentMappingLabel.stringValue = String(
            format: "源 %.4f · 目标 %.4f · 等比缩放 %.4fx · 裁切 X %d px / Y %d px%@",
            Float(effectiveSourceWidth) / Float(max(effectiveSourceHeight, 1)),
            configuration.canvas.aspect,
            mapping.uniformScale,
            cropX,
            cropY,
            warning
        )
        contentMappingLabel.textColor = configuration.contentMode == .stretch ? .systemOrange : .secondaryLabelColor
    }

    private func refreshRuntimePreviewControls() {
        rawCalibrationButton.title = runtimePreviewMode == .rawReflectionCalibration ? "返回校正状态" : "一键无畸变标定"
        antiAliasingComparisonButton.title = runtimePreviewMode == .antiAliasingComparison ? "退出抗锯齿 A/B" : "抗锯齿 A/B 对比"
    }

    private func applyRuntimePreview(_ previewConfiguration: WarpConfiguration, message: String) {
        let validation = renderer.updateConfiguration(
            previewConfiguration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        )
        refreshRuntimePreviewControls()
        let color: NSColor = validation.isValid ? .systemOrange : .systemRed
        setStatus("\(message)；临时预览不会保存配置或增加历史。\n\(validation.summary)", color: color)
    }

    private func leaveRuntimePreview(message: String = "已返回校正状态") {
        runtimePreviewMode = .normal
        runtimePreviewReturnMode = .normal
        let validation = renderer.updateConfiguration(configuration)
        refreshRuntimePreviewControls()
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
        performanceTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.refreshPerformanceStatus()
        }
    }

    private func refreshPerformanceStatus() {
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
        configuration.canvas.width = NumericInput.integer(from: canvasWidthField.stringValue) ?? configuration.canvas.width
        configuration.canvas.height = NumericInput.integer(from: canvasHeightField.stringValue) ?? configuration.canvas.height
        applyConfiguration("画布尺寸已应用")
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
        pauseWarpButton.title = visible ? "暂停 Warp" : "恢复 Warp"
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
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
        startSession(showFatalOnFailure: false)
        if emergencyHotKey == nil {
            controlPanel?.setStatus("警告：全局紧急快捷键注册失败，请使用控制台的“暂停 Warp”。", color: .systemRed)
        }
    }

    private func startSession(showFatalOnFailure: Bool) {
        startupRetryWorkItem?.cancel()
        guard let topology = chooseScreens(),
              let outputID = displayID(for: topology.output) else {
            if showFatalOnFailure {
                showFatal("需要同时连接 MacBook 内置屏和一台外接显示器。")
            } else {
                emergencyHideWarp(reason: "未检测到外接屏，Warp 已安全隐藏；重新连接后会自动恢复。")
                scheduleStartupRetry()
            }
            return
        }
        let displayMode = CGDisplayCopyDisplayMode(outputID)
        let pixelWidth = displayMode?.pixelWidth ?? CGDisplayPixelsWide(outputID)
        let pixelHeight = displayMode?.pixelHeight ?? CGDisplayPixelsHigh(outputID)
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
            if showFatalOnFailure {
                showFatal("无法初始化 Metal 输出。")
            } else {
                emergencyHideWarp(reason: "外屏尚未就绪，Warp 已安全隐藏；程序会自动重试。")
                scheduleStartupRetry()
            }
            return
        }
        self.outputController = outputController
        controlPanel?.close()
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
                    do {
                        try await self?.captureEngine.updateSourceMode(
                            captureConfiguration.sourceMode,
                            minimumCoverage: captureConfiguration.fullscreenCoverageThreshold
                        )
                    } catch {
                        self?.controlPanel?.setStatus(
                            "切换输入源失败：\(error.localizedDescription)。已保留当前捕获。",
                            color: .systemOrange
                        )
                    }
                }
            }
        )
        self.controlPanel = controlPanel
        NSApp.activate(ignoringOtherApps: true)
        controlPanel.bringToFront()
        captureEngine.onError = { [weak self] message in
            self?.emergencyHideWarp(reason: "捕获中断：\(message)。Warp 覆盖层已安全隐藏。")
        }
        captureEngine.onNotice = { [weak self] message in
            self?.controlPanel?.setStatus(message, color: .systemOrange)
        }
        captureEngine.onPresentation = { [weak controlPanel] presentation in
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

        Task {
            do {
                try await captureEngine.start(
                    displayID: outputID,
                    pixelWidth: pixelWidth,
                    pixelHeight: pixelHeight,
                    sourceMode: configuration.capture.sourceMode,
                    minimumCoverage: configuration.capture.fullscreenCoverageThreshold
                )
                await MainActor.run {
                    controlPanel.setStatus(
                        configuration.capture.sourceMode == .automaticFullscreenWindow
                            ? "自动跟随已启动：播放器进入全屏后会在约 1 秒内切为单窗口捕获。"
                            : "正在捕获外屏完整桌面；AA 区外纯黑，配置会自动保存。"
                    )
                    NSApp.activate(ignoringOtherApps: true)
                    controlPanel.bringToFront()
                }
            } catch {
                await MainActor.run {
                    self.emergencyHideWarp(reason: "启动失败：\(error.localizedDescription)。Warp 覆盖层已安全隐藏。")
                }
            }
        }
    }

    private func restartSession(reason: String) {
        guard !isReconfiguring else { return }
        isReconfiguring = true
        emergencyHideWarp(reason: reason)
        Task {
            await captureEngine.stop()
            await MainActor.run {
                outputController = nil
                startSession(showFatalOnFailure: false)
                isReconfiguring = false
            }
        }
    }

    private func scheduleStartupRetry() {
        startupRetryWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.outputController == nil, !self.isReconfiguring else { return }
            self.startSession(showFatalOnFailure: false)
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
        screenChangeWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.restartSession(reason: "检测到外屏连接或分辨率变化，已隐藏覆盖层并重建输出。")
        }
        screenChangeWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: workItem)
    }

    @objc private func screensDidSleep() {
        emergencyHideWarp(reason: "显示器已休眠，Warp 覆盖层已安全隐藏。")
        Task { await captureEngine.stop() }
    }

    @objc private func screensDidWake() {
        restartSession(reason: "显示器已唤醒，正在重建 Warp 输出。")
    }

    func applicationWillTerminate(_ notification: Notification) {
        startupRetryWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        Task { await captureEngine.stop() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func chooseScreens() -> (source: NSScreen, output: NSScreen)? {
        let screens = NSScreen.screens
        guard screens.count >= 2 else { return nil }
        let builtIn = screens.first(where: { screen in
            guard let id = displayID(for: screen) else { return false }
            return CGDisplayIsBuiltin(id) != 0
        }) ?? NSScreen.main ?? screens[0]
        let output = screens
            .filter { $0 !== builtIn }
            .max { lhs, rhs in lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height }
        guard let output else { return nil }
        return (builtIn, output)
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

    private func showFatal(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "NIO Warp 无法启动"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
private let appDelegate = AppDelegate()
application.delegate = appDelegate
application.run()
