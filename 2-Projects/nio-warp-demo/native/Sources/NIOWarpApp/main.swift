import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Metal
import MetalKit
import ScreenCaptureKit

private struct WarpParameters {
    var enabled = true
    var strength: Float = 1.0
    var arch: Float = 0.105
    var verticalScale: Float = 0.83
    var asymmetry: Float = 0.08
    var tilt: Float = 0.025
    var horizontalBend: Float = 0.018
}

private enum ContentMode: Int32, CaseIterable {
    case fit = 0
    case fill = 1
    case stretch = 2

    var title: String {
        switch self {
        case .fit: return "完整显示"
        case .fill: return "铺满裁切"
        case .stretch: return "拉伸铺满"
        }
    }
}

private struct MeshVertex {
    var position: SIMD2<Float>
    var uv: SIMD2<Float>
}

private struct ShaderUniforms {
    var sourceAspect: Float
    var outputAspect: Float
    var contentMode: Int32
    var padding: Int32 = 0
}

private final class LatestFrameStore {
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
    private(set) var sourceName = ""
    var onError: ((String) -> Void)?

    func start(displayID: CGDirectDisplayID) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw NSError(domain: "NIOWarp", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法找到源显示器"])
        }

        let currentBundleID = Bundle.main.bundleIdentifier
        let excludedApplications = content.applications.filter { application in
            application.bundleIdentifier == currentBundleID
        }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApplications,
            exceptingWindows: []
        )
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 3
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.scalesToFit = false

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        sourceName = "\(display.width)×\(display.height)"
        try await stream.startCapture()
    }

    func stop() async {
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
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
}

private final class WarpRenderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private var textureCache: CVMetalTextureCache?
    private let frameStore: LatestFrameStore
    private var vertexBuffer: MTLBuffer?
    private var indexBuffer: MTLBuffer?
    private var indexCount = 0
    private let meshColumns = 96
    private let meshRows = 40
    private var parameters = WarpParameters()
    private var contentMode = ContentMode.fit

    init?(view: MTKView, frameStore: LatestFrameStore) {
        guard let device = MTLCreateSystemDefaultDevice(),
              let commandQueue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.commandQueue = commandQueue
        self.frameStore = frameStore

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
            float outputAspect;
            int contentMode;
            int padding;
        };

        vertex VertexOut vertexMain(VertexIn input [[stage_in]]) {
            VertexOut output;
            output.position = float4(input.position, 0.0, 1.0);
            output.uv = input.uv;
            return output;
        }

        fragment float4 fragmentMain(
            VertexOut input [[stage_in]],
            texture2d<float> source [[texture(0)]],
            constant Uniforms& uniforms [[buffer(1)]]) {
            constexpr sampler textureSampler(filter::linear, address::clamp_to_zero);
            float2 uv = input.uv;

            if (uniforms.contentMode == 0) {
                if (uniforms.sourceAspect < uniforms.outputAspect) {
                    float visibleWidth = uniforms.sourceAspect / uniforms.outputAspect;
                    uv.x = (uv.x - (1.0 - visibleWidth) * 0.5) / visibleWidth;
                } else {
                    float visibleHeight = uniforms.outputAspect / uniforms.sourceAspect;
                    uv.y = (uv.y - (1.0 - visibleHeight) * 0.5) / visibleHeight;
                }
            } else if (uniforms.contentMode == 1) {
                if (uniforms.sourceAspect < uniforms.outputAspect) {
                    float sampledHeight = uniforms.sourceAspect / uniforms.outputAspect;
                    uv.y = uv.y * sampledHeight + (1.0 - sampledHeight) * 0.5;
                } else {
                    float sampledWidth = uniforms.outputAspect / uniforms.sourceAspect;
                    uv.x = uv.x * sampledWidth + (1.0 - sampledWidth) * 0.5;
                }
            }

            if (any(uv < 0.0) || any(uv > 1.0)) {
                return float4(0.0, 0.0, 0.0, 1.0);
            }
            return source.sample(textureSampler, uv);
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
        view.preferredFramesPerSecond = 60
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        view.framebufferOnly = true
        CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
        rebuildMesh()
    }

    func updateParameters(_ parameters: WarpParameters) {
        self.parameters = parameters
        rebuildMesh()
    }

    func updateContentMode(_ contentMode: ContentMode) {
        self.contentMode = contentMode
    }

    private func rawWarp(x: Float, y: Float) -> SIMD2<Float> {
        guard parameters.enabled else { return SIMD2<Float>(x, y) }
        let strength = parameters.strength
        let centeredX = x * 2 - 1
        let centeredY = y * 2 - 1
        let horizontalScale = 1 + (0.97 - 1) * strength - 0.07 * strength * centeredY + 0.025 * strength * centeredX
        let warpedX = 0.5
            + 0.5 * centeredX * horizontalScale
            + parameters.horizontalBend * strength * centeredY * (1 - centeredX * centeredX)
        let verticalScale = 1 + (parameters.verticalScale - 1) * strength
        let warpedY = 0.5
            + 0.5 * centeredY * (verticalScale + parameters.asymmetry * strength * centeredX)
            - parameters.arch * strength * (1 - centeredX * centeredX)
            + parameters.tilt * strength * centeredX
            + 0.018 * strength * centeredX * centeredY
        return SIMD2<Float>(warpedX, warpedY)
    }

    private func warpBounds() -> (minimum: SIMD2<Float>, maximum: SIMD2<Float>) {
        var minimum = SIMD2<Float>(repeating: .greatestFiniteMagnitude)
        var maximum = SIMD2<Float>(repeating: -.greatestFiniteMagnitude)
        for row in 0...30 {
            for column in 0...60 {
                let warped = rawWarp(x: Float(column) / 60, y: Float(row) / 30)
                minimum = SIMD2<Float>(Swift.min(minimum.x, warped.x), Swift.min(minimum.y, warped.y))
                maximum = SIMD2<Float>(Swift.max(maximum.x, warped.x), Swift.max(maximum.y, warped.y))
            }
        }
        let margin = (maximum - minimum) * 0.006
        return (minimum - margin, maximum + margin)
    }

    private func rebuildMesh() {
        let bounds = warpBounds()
        let range = bounds.maximum - bounds.minimum
        var vertices = [MeshVertex]()
        vertices.reserveCapacity((meshColumns + 1) * (meshRows + 1))
        for row in 0...meshRows {
            let y = Float(row) / Float(meshRows)
            for column in 0...meshColumns {
                let x = Float(column) / Float(meshColumns)
                let warped = rawWarp(x: x, y: y)
                let uv = (warped - bounds.minimum) / range
                vertices.append(
                    MeshVertex(
                        position: SIMD2<Float>(x * 2 - 1, 1 - y * 2),
                        uv: uv
                    )
                )
            }
        }

        var indices = [UInt32]()
        indices.reserveCapacity(meshColumns * meshRows * 6)
        let stride = meshColumns + 1
        for row in 0..<meshRows {
            for column in 0..<meshColumns {
                let topLeft = UInt32(row * stride + column)
                let topRight = topLeft + 1
                let bottomLeft = UInt32((row + 1) * stride + column)
                let bottomRight = bottomLeft + 1
                indices.append(contentsOf: [topLeft, topRight, bottomRight, topLeft, bottomRight, bottomLeft])
            }
        }

        vertexBuffer = device.makeBuffer(bytes: vertices, length: vertices.count * MemoryLayout<MeshVertex>.stride)
        indexBuffer = device.makeBuffer(bytes: indices, length: indices.count * MemoryLayout<UInt32>.stride)
        indexCount = indices.count
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
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

        var uniforms = ShaderUniforms(
            sourceAspect: Float(width) / Float(height),
            outputAspect: Float(view.drawableSize.width / max(view.drawableSize.height, 1)),
            contentMode: contentMode.rawValue
        )

        encoder.setRenderPipelineState(pipeline)
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
        commandBuffer.addCompletedHandler { _ in
            _ = cvTexture
        }
        commandBuffer.commit()
    }
}

private final class OutputWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class OutputController {
    let window: NSWindow
    let renderer: WarpRenderer

    init?(screen: NSScreen, frameStore: LatestFrameStore) {
        let window = OutputWindow(
            contentRect: screen.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        window.backgroundColor = .black
        window.isOpaque = true
        window.hasShadow = false
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.level = .screenSaver
        window.ignoresMouseEvents = true
        window.hidesOnDeactivate = false

        let metalView = MTKView(frame: screen.frame)
        metalView.autoresizingMask = [.width, .height]
        guard let renderer = WarpRenderer(view: metalView, frameStore: frameStore) else { return nil }
        metalView.delegate = renderer
        window.contentView = metalView
        window.setFrame(screen.frame, display: true)
        window.orderFrontRegardless()

        self.window = window
        self.renderer = renderer
    }
}

private final class ControlPanelController: NSWindowController {
    private let renderer: WarpRenderer
    private var parameters = WarpParameters()
    private let statusLabel = NSTextField(labelWithString: "等待屏幕捕获权限…")
    private let warpButton = NSButton(checkboxWithTitle: "启用 Warp", target: nil, action: nil)

    init(renderer: WarpRenderer, sourceScreen: NSScreen, outputScreen: NSScreen) {
        self.renderer = renderer
        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 540),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "NIO 全屏 Warp 控制台"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        super.init(window: panel)
        buildInterface(sourceScreen: sourceScreen, outputScreen: outputScreen)
        panel.center()
        bringToFront()
    }

    required init?(coder: NSCoder) { nil }

    private func buildInterface(sourceScreen: NSScreen, outputScreen: NSScreen) {
        guard let contentView = window?.contentView else { return }
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -22),
        ])

        let title = NSTextField(labelWithString: "三星外屏桌面 → 实时 Warp → 同一块三星外屏")
        title.font = .systemFont(ofSize: 18, weight: .bold)
        stack.addArrangedSubview(title)
        let topology = NSTextField(wrappingLabelWithString: "源：\(screenName(sourceScreen))\n输出：\(screenName(outputScreen))\n程序覆盖层从 ScreenCaptureKit 中排除，因此不会产生递归回采。")
        topology.textColor = .secondaryLabelColor
        stack.addArrangedSubview(topology)

        warpButton.state = .on
        warpButton.target = self
        warpButton.action = #selector(toggleWarp(_:))
        stack.addArrangedSubview(warpButton)

        stack.addArrangedSubview(makeSlider(title: "Warp 强度", minimum: 0, maximum: 1.5, value: 1.0, action: #selector(updateStrength(_:))))
        stack.addArrangedSubview(makeSlider(title: "上下弧度", minimum: 0, maximum: 0.18, value: 0.105, action: #selector(updateArch(_:))))
        stack.addArrangedSubview(makeSlider(title: "垂直压缩", minimum: 0.68, maximum: 1.0, value: 0.83, action: #selector(updateVerticalScale(_:))))
        stack.addArrangedSubview(makeSlider(title: "左右不对称", minimum: -0.15, maximum: 0.15, value: 0.08, action: #selector(updateAsymmetry(_:))))
        stack.addArrangedSubview(makeSlider(title: "整体倾斜", minimum: -0.1, maximum: 0.1, value: 0.025, action: #selector(updateTilt(_:))))

        let modeLabel = NSTextField(labelWithString: "内容适配")
        modeLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        stack.addArrangedSubview(modeLabel)
        let modePicker = NSPopUpButton()
        ContentMode.allCases.forEach { modePicker.addItem(withTitle: $0.title) }
        modePicker.target = self
        modePicker.action = #selector(updateContentMode(_:))
        stack.addArrangedSubview(modePicker)

        statusLabel.textColor = .systemOrange
        statusLabel.maximumNumberOfLines = 3
        stack.addArrangedSubview(statusLabel)

        let hint = NSTextField(wrappingLabelWithString: "现在外屏原有桌面和所有窗口都会被整体 Warp。覆盖层不接收鼠标，点击会穿透到下方原窗口；但 Warp 后的视觉坐标与实际点击坐标暂未反向校正，当前建议用于展示而非精确交互。")
        hint.textColor = .secondaryLabelColor
        stack.addArrangedSubview(hint)

        let quitButton = NSButton(title: "退出 Warp", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        stack.addArrangedSubview(quitButton)
    }

    private func screenName(_ screen: NSScreen) -> String {
        let name = screen.localizedName
        let size = screen.frame.size
        return "\(name) · \(Int(size.width))×\(Int(size.height)) pt"
    }

    private func makeSlider(title: String, minimum: Double, maximum: Double, value: Double, action: Selector) -> NSView {
        let container = NSStackView()
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = 4
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        let slider = NSSlider(value: value, minValue: minimum, maxValue: maximum, target: self, action: action)
        slider.isContinuous = true
        slider.widthAnchor.constraint(equalToConstant: 340).isActive = true
        container.addArrangedSubview(label)
        container.addArrangedSubview(slider)
        return container
    }

    func setStatus(_ text: String, color: NSColor = .systemGreen) {
        statusLabel.stringValue = text
        statusLabel.textColor = color
    }

    func bringToFront() {
        guard let window else { return }
        window.orderFrontRegardless()
        window.makeKey()
    }

    @objc private func toggleWarp(_ sender: NSButton) {
        parameters.enabled = sender.state == .on
        renderer.updateParameters(parameters)
    }

    @objc private func updateStrength(_ sender: NSSlider) {
        parameters.strength = Float(sender.doubleValue)
        renderer.updateParameters(parameters)
    }

    @objc private func updateArch(_ sender: NSSlider) {
        parameters.arch = Float(sender.doubleValue)
        renderer.updateParameters(parameters)
    }

    @objc private func updateVerticalScale(_ sender: NSSlider) {
        parameters.verticalScale = Float(sender.doubleValue)
        renderer.updateParameters(parameters)
    }

    @objc private func updateAsymmetry(_ sender: NSSlider) {
        parameters.asymmetry = Float(sender.doubleValue)
        renderer.updateParameters(parameters)
    }

    @objc private func updateTilt(_ sender: NSSlider) {
        parameters.tilt = Float(sender.doubleValue)
        renderer.updateParameters(parameters)
    }

    @objc private func updateContentMode(_ sender: NSPopUpButton) {
        guard let mode = ContentMode(rawValue: Int32(sender.indexOfSelectedItem)) else { return }
        renderer.updateContentMode(mode)
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let captureEngine = CaptureEngine()
    private var outputController: OutputController?
    private var controlPanel: ControlPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        guard let topology = chooseScreens() else {
            showFatal("需要同时连接 MacBook 内置屏和一台外接显示器。")
            return
        }
        guard let outputController = OutputController(screen: topology.output, frameStore: captureEngine.frameStore) else {
            showFatal("无法初始化 Metal 输出。")
            return
        }
        self.outputController = outputController
        let controlPanel = ControlPanelController(
            renderer: outputController.renderer,
            sourceScreen: topology.source,
            outputScreen: topology.output
        )
        self.controlPanel = controlPanel
        NSApp.activate(ignoringOtherApps: true)
        controlPanel.bringToFront()
        captureEngine.onError = { [weak controlPanel] message in
            controlPanel?.setStatus("捕获中断：\(message)", color: .systemRed)
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

        guard let sourceID = displayID(for: topology.source) else {
            showFatal("无法取得源显示器 ID。")
            return
        }
        Task {
            do {
                try await captureEngine.start(displayID: sourceID)
                await MainActor.run {
                    controlPanel.setStatus("正在以 60 FPS 捕获三星外屏完整桌面，并排除自身覆盖层后回显到同一外屏。")
                    NSApp.activate(ignoringOtherApps: true)
                    controlPanel.bringToFront()
                }
            } catch {
                await MainActor.run {
                    controlPanel.setStatus("启动失败：\(error.localizedDescription)", color: .systemRed)
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
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
            .max { lhs, rhs in
                lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
            }
        guard let output else { return nil }
        return (output, output)
    }

    private func displayID(for screen: NSScreen) -> CGDirectDisplayID? {
        screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
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
