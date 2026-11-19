import AppKit
import CoreGraphics
import simd

/// Local RBF offsets are stored before output-height scaling and final alignment.
/// The editor operates in visible physical-pixel axes, so vectors cross both transforms.
private enum LocalWarpEditingCoordinates {
    static func angle(configuration: WarpConfiguration) -> Double {
        guard configuration.alignment.level else { return 0 }
        var unaligned = configuration
        unaligned.alignment = WarpAlignmentConfiguration()
        let axis = WarpMath.physicalPoints(canvasPoints: [SIMD2(0, 0.5), SIMD2(1, 0.5)], configuration: unaligned)
        let direction = axis[1] - axis[0]
        guard direction.x.isFinite, direction.y.isFinite, simd_length(direction) > 0.0001 else { return 0 }
        return -atan2(Double(direction.y), Double(direction.x))
    }

    private static func rotate(_ vector: SIMD2<Double>, angle: Double) -> SIMD2<Double> {
        SIMD2(cos(angle) * vector.x - sin(angle) * vector.y, sin(angle) * vector.x + cos(angle) * vector.y)
    }

    static func modelVector(_ vector: SIMD2<Double>, configuration: WarpConfiguration) -> SIMD2<Double> {
        let unrotated = rotate(vector, angle: -angle(configuration: configuration))
        let scale = configuration.manual.enabled ? configuration.manual.verticalAspectScale : 1
        return SIMD2(unrotated.x, unrotated.y / scale)
    }

    static func screenVector(_ vector: SIMD2<Double>, configuration: WarpConfiguration) -> SIMD2<Double> {
        let scale = configuration.manual.enabled ? configuration.manual.verticalAspectScale : 1
        return rotate(SIMD2(vector.x, vector.y * scale), angle: angle(configuration: configuration))
    }
}

final class LocalWarpCanvasView: NSView {
    private(set) var configuration: WarpConfiguration?
    private(set) var mesh: GeneratedMesh?
    var selectedCoordinate: SIMD2<Double>? { didSet { refreshSelection(); needsDisplay = true } }
    var onSelect: ((SIMD2<Double>?) -> Void)?
    var onDirection: ((UInt16, NSEvent.ModifierFlags, Bool) -> Void)?
    var onUndo: (() -> Void)?
    var magnified = false
    private var physicalBounds: NSRect?
    private var sharedViewport: WarpEditorViewport?
    private var zoom: CGFloat = 1
    private var pan = NSPoint.zero
    private var previousDrag: NSPoint?
    private var field: LocalWarpField?
    private var selectedPhysical: SIMD2<Float>?
    private var selectedOffset = SIMD2<Double>.zero
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { !magnified }

    func update(configuration: WarpConfiguration, mesh: GeneratedMesh) {
        if self.configuration?.localWarp != configuration.localWarp { field = LocalWarpField(configuration.localWarp) }
        self.configuration = configuration
        self.mesh = mesh
        refreshSelection()
        if physicalBounds == nil { fit() }
        needsDisplay = true
    }

    private func refreshSelection() {
        guard let selectedCoordinate else { selectedPhysical = nil; selectedOffset = .zero; return }
        selectedPhysical = physicalPoint(for: selectedCoordinate)
        if let configuration, configuration.localWarp.enabled {
            selectedOffset = LocalWarpEditingCoordinates.screenVector(field?.displacement(at: selectedCoordinate) ?? .zero, configuration: configuration)
        } else { selectedOffset = .zero }
    }

    func fit() {
        guard let config = configuration, let mesh else { return }
        var minimum = SIMD2(Float(config.aaRect.x * Double(config.displayPixelWidth)), Float(config.aaRect.y * Double(config.displayPixelHeight)))
        var maximum = minimum + SIMD2(Float(config.aaRect.width * Double(config.displayPixelWidth)), Float(config.aaRect.height * Double(config.displayPixelHeight)))
        for vertex in mesh.vertices {
            let point = SIMD2((vertex.position.x + 1) * 0.5 * Float(config.displayPixelWidth), (1 - vertex.position.y) * 0.5 * Float(config.displayPixelHeight))
            minimum = simd_min(minimum, point)
            maximum = simd_max(maximum, point)
        }
        physicalBounds = NSRect(x: CGFloat(minimum.x), y: CGFloat(minimum.y), width: CGFloat(max(maximum.x - minimum.x, 1)), height: CGFloat(max(maximum.y - minimum.y, 1)))
        sharedViewport = nil
        zoom = 1
        pan = .zero
        needsDisplay = true
    }

    func cancelInteraction() { previousDrag = nil }

    var viewport: WarpEditorViewport? {
        get {
            guard physicalBounds != nil, bounds.width > 0, bounds.height > 0 else { return nil }
            let mapping = transform
            return WarpEditorViewport(physicalBounds: NSRect(
                x: mapping.center.x - bounds.width / (2 * mapping.scale),
                y: mapping.center.y - bounds.height / (2 * mapping.scale),
                width: bounds.width / mapping.scale, height: bounds.height / mapping.scale), pointsPerPhysicalPixel: mapping.scale)
        }
        set {
            guard let newValue, newValue.isValid else { return }
            physicalBounds = newValue.physicalBounds
            sharedViewport = newValue
            zoom = 1; pan = .zero; needsDisplay = true
        }
    }

    private var transform: (scale: CGFloat, center: NSPoint) {
        let physical = physicalBounds ?? NSRect(x: 0, y: 0, width: 5000, height: 1300)
        if magnified, let selected = selectedPhysical {
            let scale = min(4, min(max(bounds.width - 44, 1) / (CGFloat(abs(selectedOffset.x)) + 24), max(bounds.height - 36, 1) / (CGFloat(abs(selectedOffset.y)) + 24)))
            return (scale, NSPoint(x: CGFloat(selected.x) - CGFloat(selectedOffset.x) / 2, y: CGFloat(selected.y) - CGFloat(selectedOffset.y) / 2))
        }
        let baseScale = sharedViewport.map {
            $0.pointsPerPhysicalPixel ?? min(max(bounds.width, 1) / physical.width, max(bounds.height, 1) / physical.height)
        } ?? min(max(bounds.width - 44, 1) / physical.width, max(bounds.height - 44, 1) / physical.height)
        let scale = max(0.000001, baseScale * zoom)
        return (scale, NSPoint(x: physical.midX - pan.x / scale, y: physical.midY - pan.y / scale))
    }

    func viewPoint(for physical: SIMD2<Float>) -> NSPoint {
        let mapping = transform
        return NSPoint(x: bounds.midX + (CGFloat(physical.x) - mapping.center.x) * mapping.scale, y: bounds.midY + (CGFloat(physical.y) - mapping.center.y) * mapping.scale)
    }

    func physicalPoint(for coordinate: SIMD2<Double>) -> SIMD2<Float>? {
        guard let config = configuration, let mesh else { return nil }
        return mesh.renderedPhysicalPoint(at: config.canvasUV(for: coordinate), width: config.displayPixelWidth, height: config.displayPixelHeight)
    }

    func changeZoom(by factor: CGFloat) {
        zoom = min(max(zoom * factor, 0.25), 128)
        if let selectedCoordinate, let physical = physicalPoint(for: selectedCoordinate), let physicalBounds {
            let scale = transform.scale
            pan = NSPoint(x: -(CGFloat(physical.x) - physicalBounds.midX) * scale, y: -(CGFloat(physical.y) - physicalBounds.midY) * scale)
        }
        needsDisplay = true
    }

    func pick(at viewPoint: NSPoint) -> SIMD2<Double>? {
        guard let config = configuration, let mesh else { return nil }
        var candidates = config.localWarp.anchors.map(\.coordinate)
        let nearbyAnchor = candidates.compactMap { coordinate -> (SIMD2<Double>, CGFloat)? in
            guard let physical = physicalPoint(for: coordinate) else { return nil }
            let projected = self.viewPoint(for: physical)
            return (coordinate, hypot(projected.x - viewPoint.x, projected.y - viewPoint.y))
        }.min { $0.1 < $1.1 }
        if let nearbyAnchor, nearbyAnchor.1 <= 7 { return nearbyAnchor.0 }
        let mapping = transform
        let physical = SIMD2(Float(mapping.center.x + (viewPoint.x - bounds.midX) / mapping.scale), Float(mapping.center.y + (viewPoint.y - bounds.midY) / mapping.scale))
        if let source = mesh.sourceUV(at: physical, width: config.displayPixelWidth, height: config.displayPixelHeight) {
            let scale = config.gridUVScale
            let grid = 0.5 + (source - 0.5) * scale
            let columns = config.render.calibrationGrid.columns
            let rows = config.render.calibrationGrid.rows
            let column = Int((grid.x * Float(columns)).rounded())
            let row = Int((grid.y * Float(rows)).rounded())
            for vertical in (row - 1)...(row + 1) {
                for horizontal in (column - 1)...(column + 1) {
                    let uv = 0.5 + (SIMD2(Float(horizontal) / Float(columns), Float(vertical) / Float(rows)) - 0.5) / scale
                    if uv.x >= 0, uv.x <= 1, uv.y >= 0, uv.y <= 1 { candidates.append(config.localCoordinate(at: uv)) }
                }
            }
        }
        var selected: SIMD2<Double>?
        var distance = CGFloat(18)
        for candidate in candidates {
            guard let physical = physicalPoint(for: candidate) else { continue }
            let projected = self.viewPoint(for: physical)
            let separation = hypot(projected.x - viewPoint.x, projected.y - viewPoint.y)
            if separation < distance { selected = candidate; distance = separation }
        }
        return selected
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let location = convert(event.locationInWindow, from: nil)
        previousDrag = location
        if let coordinate = pick(at: location) { selectedCoordinate = coordinate; onSelect?(coordinate) }
    }

    override func mouseDragged(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        if let previousDrag { pan.x += location.x - previousDrag.x; pan.y += location.y - previousDrag.y }
        previousDrag = location
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) { previousDrag = nil }

    override func scrollWheel(with event: NSEvent) {
        pan.x -= event.scrollingDeltaX
        pan.y -= event.scrollingDeltaY
        needsDisplay = true
    }

    override func magnify(with event: NSEvent) { changeZoom(by: max(0.25, 1 + event.magnification)) }

    override func keyDown(with event: NSEvent) {
        if (123...126).contains(event.keyCode) { onDirection?(event.keyCode, event.modifierFlags, event.isARepeat); return }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "z" { onUndo?(); return }
        if event.keyCode == 53 { selectedCoordinate = nil; onSelect?(nil); return }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSBezierPath(rect: bounds).addClip()
        NSColor(calibratedWhite: 0.055, alpha: 1).setFill()
        bounds.fill()
        guard let config = configuration, let mesh else { return }
        func sample(_ uv: SIMD2<Float>) -> NSPoint? {
            mesh.renderedPhysicalPoint(at: uv, width: config.displayPixelWidth, height: config.displayPixelHeight).map { viewPoint(for: $0) }
        }
        func line(_ coordinates: [SIMD2<Float>], color: NSColor, width: CGFloat) {
            let path = NSBezierPath()
            var started = false
            for coordinate in coordinates {
                guard let point = sample(coordinate) else { started = false; continue }
                if started { path.line(to: point) } else { path.move(to: point); started = true }
            }
            path.lineWidth = width
            color.setStroke()
            path.stroke()
        }
        let scale = config.gridUVScale
        let count = SIMD2(Float(config.render.calibrationGrid.columns), Float(config.render.calibrationGrid.rows))
        let minimum = (0.5 - scale * 0.5) * count
        let maximum = (0.5 + scale * 0.5) * count
        let horizontalStart = Int(ceil(minimum.x))
        let horizontalEnd = Int(floor(maximum.x))
        let verticalStart = Int(ceil(minimum.y))
        let verticalEnd = Int(floor(maximum.y))
        let lineLimit = magnified ? 80 : min(600, max(80, Int(80 * zoom)))
        let columnStride = max(1, (horizontalEnd - horizontalStart + 1) / lineLimit)
        let rowStride = max(1, (verticalEnd - verticalStart + 1) / lineLimit)
        if horizontalStart <= horizontalEnd {
            for index in stride(from: horizontalStart, through: horizontalEnd, by: columnStride) {
                let horizontal = 0.5 + (Float(index) / count.x - 0.5) / scale.x
                line((0...96).map { SIMD2(horizontal, Float($0) / 96) }, color: .white.withAlphaComponent(0.62), width: 0.8)
            }
        }
        if verticalStart <= verticalEnd {
            for index in stride(from: verticalStart, through: verticalEnd, by: rowStride) {
                let vertical = 0.5 + (Float(index) / count.y - 0.5) / scale.y
                line((0...128).map { SIMD2(Float($0) / 128, vertical) }, color: .white.withAlphaComponent(0.62), width: 0.8)
            }
        }
        let corners = [SIMD2<Float>(0, 0), SIMD2(1, 0), SIMD2(1, 1), SIMD2(0, 1), SIMD2(0, 0)]
        for index in 0..<4 {
            line((0...96).map { corners[index] + (corners[index + 1] - corners[index]) * (Float($0) / 96) }, color: .systemCyan, width: 1.3)
        }
        let aa = config.aaRect
        let topLeft = viewPoint(for: SIMD2(Float(aa.x * Double(config.displayPixelWidth)), Float(aa.y * Double(config.displayPixelHeight))))
        let bottomRight = viewPoint(for: SIMD2(Float((aa.x + aa.width) * Double(config.displayPixelWidth)), Float((aa.y + aa.height) * Double(config.displayPixelHeight))))
        NSColor.systemYellow.setStroke()
        NSBezierPath(rect: NSRect(x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y)).stroke()
        for anchor in config.localWarp.anchors {
            guard let physical = physicalPoint(for: anchor.coordinate) else { continue }
            let point = viewPoint(for: physical)
            NSColor.systemCyan.setFill()
            NSBezierPath(ovalIn: NSRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)).fill()
        }
        if let selectedCoordinate, let physical = physicalPoint(for: selectedCoordinate) {
            let point = viewPoint(for: physical)
            let uv = config.canvasUV(for: selectedCoordinate)
            line((0...160).map { SIMD2(uv.x, Float($0) / 160) }, color: .white, width: 1.4)
            line((0...160).map { SIMD2(Float($0) / 160, uv.y) }, color: .white, width: 1.4)
            let delta = selectedOffset
            let base = viewPoint(for: physical - SIMD2(Float(delta.x), Float(delta.y)))
            NSColor.systemGray.setStroke()
            let cross = NSBezierPath()
            cross.move(to: NSPoint(x: base.x - 7, y: base.y)); cross.line(to: NSPoint(x: base.x + 7, y: base.y))
            cross.move(to: NSPoint(x: base.x, y: base.y - 7)); cross.line(to: NSPoint(x: base.x, y: base.y + 7))
            cross.stroke()
            NSColor.systemOrange.setStroke()
            let vector = NSBezierPath()
            vector.move(to: base)
            vector.line(to: point)
            vector.stroke()
            NSColor.systemOrange.setFill()
            NSBezierPath(ovalIn: NSRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10)).fill()
        }
    }
}

private final class LocalEditorDocument: NSView { override var isFlipped: Bool { true } }

final class LocalWarpEditorController: NSWindowController, NSWindowDelegate {
    var onChange: ((LocalWarpConfiguration, Bool) -> Void)?
    var onUndo: (() -> Void)?
    var onClose: (() -> Void)?
    var onShowPolynomial: (() -> Void)?
    let canvasView = LocalWarpCanvasView()
    let embeddedPreview = NSView()
    let embeddedInspector = NSScrollView()
    private(set) var isEmbedded: Bool
    private var standaloneConstraints = [NSLayoutConstraint]()
    private let loupeView = LocalWarpCanvasView()
    private var working: WarpConfiguration
    private var available: Bool
    private let enabledButton = NSButton(checkboxWithTitle: "启用局部修正", target: nil, action: nil)
    private let boundaryButton = NSButton(checkboxWithTitle: "微调时锁住参考边界", target: nil, action: nil)
    private let stepPicker = NSPopUpButton()
    private let radiusPicker = NSPopUpButton()
    private let smoothnessPicker = NSPopUpButton()
    private let polynomialSummaryLabel = NSTextField(wrappingLabelWithString: "")
    private let anchorPicker = NSPopUpButton()
    private let selectionLabel = NSTextField(wrappingLabelWithString: "点击网格交点进行选择")
    private let offsetLabel = NSTextField(wrappingLabelWithString: "")
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let referenceLabel = NSTextField(wrappingLabelWithString: "")
    private let pointLabel = NSTextField(wrappingLabelWithString: "")
    private var editButtons = [NSButton]()
    private var undoButton: NSButton?
    private let radii = [0.5, 1.0, 2.0, 3.0, 4.0]
    private let steps = [0.1, 1.0, 10.0]
    private var pending = false

    var draftConfiguration: WarpConfiguration { working }
    var statusText: String { statusLabel.stringValue }

    func showStatus(_ message: String, error: Bool = false) {
        statusLabel.stringValue = message
        statusLabel.textColor = error ? .systemRed : .secondaryLabelColor
    }

    init(configuration: WarpConfiguration, renderedConfiguration: WarpConfiguration, mesh: GeneratedMesh, available: Bool, screen: NSScreen?, embedded: Bool = false) {
        working = configuration.preparedForLocalEditing()
        self.available = available
        isEmbedded = embedded
        let standaloneWindow: NSWindow?
        if embedded { standaloneWindow = nil }
        else {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "NIO Warp · 局部交点精调"
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 880, height: 660)
            window.level = .normal
            standaloneWindow = window
        }
        super.init(window: standaloneWindow)
        standaloneWindow?.delegate = self
        buildInterface()
        synchronize(configuration: configuration, renderedConfiguration: renderedConfiguration, mesh: mesh, available: available)
        if let window = standaloneWindow {
            let visible = Self.builtInScreen()?.visibleFrame ?? screen?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            window.setFrameOrigin(NSPoint(x: visible.midX - window.frame.width / 2, y: visible.midY - window.frame.height / 2))
        }
    }

    required init?(coder: NSCoder) { nil }

    func prepareForEmbedding() {
        guard !isEmbedded else { return }
        deactivateInteraction()
        isEmbedded = true
        NSLayoutConstraint.deactivate(standaloneConstraints)
        standaloneConstraints.removeAll()
        embeddedPreview.removeFromSuperview()
        embeddedInspector.removeFromSuperview()
        window?.orderOut(nil)
        window?.delegate = nil
        window = nil
    }

    /// Navigation ends a pan gesture but preserves selection, camera, settings,
    /// and already submitted local-warp changes awaiting validation.
    func deactivateInteraction() { canvasView.cancelInteraction() }

    var viewport: WarpEditorViewport? {
        get { canvasView.viewport }
        set { canvasView.viewport = newValue }
    }

    func setEditingAvailable(_ available: Bool) {
        self.available = available
        refresh()
    }

    override func showWindow(_ sender: Any?) {
        guard !isEmbedded else { return }
        super.showWindow(sender)
    }

    private func label(_ text: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.preferredMaxLayoutWidth = 222
        field.font = .systemFont(ofSize: 12)
        field.textColor = .secondaryLabelColor
        return field
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    private func buildInterface() {
        let left = embeddedPreview
        let scroll = embeddedInspector
        scroll.scrollerStyle = .overlay
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        [left, scroll].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        left.setAccessibilityIdentifier("nio-local-preview")
        scroll.setAccessibilityIdentifier("nio-local-inspector")
        if let content = window?.contentView {
            [left, scroll].forEach { content.addSubview($0) }
            standaloneConstraints = [
            left.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16), left.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            left.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16), left.trailingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: -16),
            scroll.topAnchor.constraint(equalTo: content.topAnchor, constant: 16), scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16), scroll.widthAnchor.constraint(equalToConstant: 260),
            ]
            NSLayoutConstraint.activate(standaloneConstraints)
        }
        let heading = NSTextField(labelWithString: "在内屏选交点；方向键按外屏物理像素微调")
        let legend = NSTextField(labelWithString: "黄＝AA；青＝曲面/已有锚点；橙＝选中点。拖动或双指滚动平移预览。")
        legend.font = .systemFont(ofSize: 11)
        legend.textColor = .secondaryLabelColor
        loupeView.magnified = true
        let previewViews = isEmbedded ? [heading, canvasView, legend] : [heading, canvasView, legend, loupeView, pointLabel]
        for view in previewViews { view.translatesAutoresizingMaskIntoConstraints = false; left.addSubview(view) }
        NSLayoutConstraint.activate([
            heading.topAnchor.constraint(equalTo: left.topAnchor), heading.leadingAnchor.constraint(equalTo: left.leadingAnchor),
            canvasView.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 8), canvasView.leadingAnchor.constraint(equalTo: left.leadingAnchor), canvasView.trailingAnchor.constraint(equalTo: left.trailingAnchor),
            canvasView.bottomAnchor.constraint(equalTo: legend.topAnchor, constant: -6), legend.leadingAnchor.constraint(equalTo: left.leadingAnchor),
        ])
        if isEmbedded {
            legend.bottomAnchor.constraint(equalTo: left.bottomAnchor).isActive = true
        } else {
            NSLayoutConstraint.activate([
                legend.bottomAnchor.constraint(equalTo: loupeView.topAnchor, constant: -8), loupeView.leadingAnchor.constraint(equalTo: left.leadingAnchor), loupeView.trailingAnchor.constraint(equalTo: left.trailingAnchor),
                loupeView.heightAnchor.constraint(equalToConstant: 150), loupeView.bottomAnchor.constraint(equalTo: pointLabel.topAnchor, constant: -8),
                pointLabel.leadingAnchor.constraint(equalTo: left.leadingAnchor), pointLabel.trailingAnchor.constraint(equalTo: left.trailingAnchor), pointLabel.bottomAnchor.constraint(equalTo: left.bottomAnchor),
            ])
        }
        pointLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        canvasView.onSelect = { [weak self] point in self?.select(point) }
        canvasView.onDirection = { [weak self] key, modifiers, repeated in self?.direction(key, modifiers: modifiers, repeated: repeated) }
        canvasView.onUndo = { [weak self] in self?.onUndo?() }
        let document = LocalEditorDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 4, bottom: 12, right: 10)
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor), stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor)])
        enabledButton.target = self
        enabledButton.action = #selector(toggleEnabled)
        enabledButton.toolTip = "只开关局部修正，不改动原多项式，不删除保存的锚点。"
        stack.addArrangedSubview(enabledButton)
        stack.addArrangedSubview(label("先开启局部修正，再点击交点。已修改的其他锚点保留约束；附近网格平滑跟随。"))
        anchorPicker.addItem(withTitle: "点击网格选择交点")
        anchorPicker.target = self
        anchorPicker.action = #selector(selectSavedAnchor)
        anchorPicker.widthAnchor.constraint(equalToConstant: 228).isActive = true
        stack.addArrangedSubview(anchorPicker)
        selectionLabel.preferredMaxLayoutWidth = 226
        stack.addArrangedSubview(selectionLabel)
        if isEmbedded {
            // Keep the main canvas in the shared workbench slot; the optional
            // close-up belongs to the selected-point inspector.
            stack.addArrangedSubview(loupeView)
            loupeView.translatesAutoresizingMaskIntoConstraints = false
            loupeView.heightAnchor.constraint(equalToConstant: 130).isActive = true
            loupeView.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -14).isActive = true
            pointLabel.preferredMaxLayoutWidth = 226
            stack.addArrangedSubview(pointLabel)
        }
        stepPicker.addItems(withTitles: ["0.1 px", "1 px", "10 px"])
        stepPicker.selectItem(at: 1)
        stepPicker.target = self
        stepPicker.action = #selector(focusCanvas)
        radiusPicker.addItems(withTitles: radii.map { "\(NumericInput.formattedDouble($0)) 个参考格" })
        radiusPicker.target = self
        radiusPicker.action = #selector(changeRadius)
        for (title, picker) in [("移动步长", stepPicker), ("影响范围", radiusPicker)] {
            stack.addArrangedSubview(NSStackView(views: [NSTextField(labelWithString: title), picker]))
        }
        stack.addArrangedSubview(label("影响范围：带动周围多远。过渡等级：改变点与点之间的曲线，不改变锚点目标位置。"))
        stack.addArrangedSubview(label("过渡平滑度（不是多项式阶数）"))
        smoothnessPicker.addItems(withTitles: LocalWarpSmoothness.allCases.map(\.title))
        smoothnessPicker.widthAnchor.constraint(equalToConstant: 228).isActive = true
        smoothnessPicker.setAccessibilityIdentifier("nio-local-smoothness")
        smoothnessPicker.target = self
        smoothnessPicker.action = #selector(changeSmoothness)
        smoothnessPicker.toolTip = "三级分别使用 C2 / C4 / C6 局部插值核。高阶不等于影响更广或一定更好；原多项式不改，其他锚点仍保留约束。"
        stack.addArrangedSubview(smoothnessPicker)
        stack.addArrangedSubview(label("先移动至少一个交点，再切换等级看周围曲线；交点目标不动。没有局部偏移时，切换不会改变画面。"))
        let up = button("↑", action: #selector(movePoint)); up.tag = 126
        let leftButton = button("←", action: #selector(movePoint)); leftButton.tag = 123
        let right = button("→", action: #selector(movePoint)); right.tag = 124
        let down = button("↓", action: #selector(movePoint)); down.tag = 125
        for (control, title) in [(up, "向上微调"), (leftButton, "向左微调"), (right, "向右微调"), (down, "向下微调")] {
            control.widthAnchor.constraint(equalToConstant: 48).isActive = true
            control.setAccessibilityLabel(title)
        }
        let centerLabel = NSTextField(labelWithString: "像素")
        centerLabel.alignment = .center
        let pad = NSGridView(views: [[NSGridCell.emptyContentView, up, NSGridCell.emptyContentView], [leftButton, centerLabel, right], [NSGridCell.emptyContentView, down, NSGridCell.emptyContentView]])
        pad.rowSpacing = 4
        pad.columnSpacing = 6
        pad.xPlacement = .center
        pad.yPlacement = .center
        pad.rowAlignment = .none
        for index in 0..<3 { pad.column(at: index).width = 48 }
        pad.widthAnchor.constraint(equalToConstant: 156).isActive = true
        pad.setAccessibilityIdentifier("nio-local-direction-pad")
        stack.addArrangedSubview(pad)
        offsetLabel.font = .monospacedSystemFont(ofSize: 13, weight: .medium)
        offsetLabel.setAccessibilityIdentifier("nio-local-offset")
        stack.addArrangedSubview(offsetLabel)
        boundaryButton.target = self
        boundaryButton.action = #selector(toggleBoundary)
        boundaryButton.toolTip = "锁住建立局部参考时的边缘；之后扩大画布不移动此参考边界。要编辑外侧点，可解锁。"
        stack.addArrangedSubview(boundaryButton)
        let reset = button("复位此点到基础位置", action: #selector(resetPoint))
        reset.toolTip = "把此点偏移设为零并保留约束，不清空其他锚点或多项式。"
        let remove = button("移除当前锚点约束", action: #selector(removePoint))
        remove.toolTip = "删除此点约束，附近其他修正仍可能影响这里；可撤销。"
        editButtons = [up, leftButton, right, down, reset, remove]
        stack.addArrangedSubview(reset)
        stack.addArrangedSubview(remove)
        let undo = button("撤销上一次设置", action: #selector(undo))
        undoButton = undo
        undo.keyEquivalent = "z"
        undo.keyEquivalentModifierMask = [.command]
        stack.addArrangedSubview(undo)
        polynomialSummaryLabel.preferredMaxLayoutWidth = 226
        stack.addArrangedSubview(polynomialSummaryLabel)
        stack.addArrangedSubview(button("打开全局多项式设置", action: #selector(showPolynomial)))
        stack.addArrangedSubview(label("先用多项式调全局趋势，再用交点修局部。改变全局后要复核局部点；这里不会自动拟合或改写多项式。"))
        stack.addArrangedSubview(NSStackView(views: [button("放大", action: #selector(zoomIn)), button("缩小", action: #selector(zoomOut)), button("适合窗口", action: #selector(fit))]))
        referenceLabel.preferredMaxLayoutWidth = 226
        referenceLabel.font = .systemFont(ofSize: 11)
        referenceLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(referenceLabel)
        stack.addArrangedSubview(label("方向键＝当前步长；Shift＝10 px；Option＝0.1 px。方向按物理屏幕，不按玻璃反射方向。放大图灰十字为基础位置；每个外屏 px 最多显示 4 pt，位移较大时自动缩小。"))
        stack.addArrangedSubview(label("网格很密时预览抽样；放大后再选点。AA 外在预览中可见，实际外屏仍裁成黑色。"))
        statusLabel.preferredMaxLayoutWidth = 226
        statusLabel.setAccessibilityIdentifier("nio-local-status")
        stack.addArrangedSubview(statusLabel)
    }

    func synchronize(configuration: WarpConfiguration, renderedConfiguration: WarpConfiguration, mesh: GeneratedMesh, available: Bool, message: String? = nil) {
        working = configuration.preparedForLocalEditing()
        self.available = available
        pending = false
        var rendered = renderedConfiguration
        rendered.localWarp.reference = working.localWarp.reference
        canvasView.update(configuration: rendered, mesh: mesh)
        loupeView.update(configuration: rendered, mesh: mesh)
        statusLabel.stringValue = message ?? (available ? "选中交点后用方向键微调；合法结果自动保存。" : "待机或临时预览中，只读查看；返回正常校正输出后可编辑。")
        statusLabel.textColor = available ? .secondaryLabelColor : .systemOrange
        refresh()
    }

    func select(_ coordinate: SIMD2<Double>?) {
        canvasView.selectedCoordinate = coordinate
        loupeView.selectedCoordinate = coordinate
        refresh()
    }

    private func refresh() {
        enabledButton.state = working.localWarp.enabled ? .on : .off
        boundaryButton.state = working.localWarp.lockBoundary ? .on : .off
        enabledButton.isEnabled = available
        undoButton?.isEnabled = available
        boundaryButton.isEnabled = available
        radiusPicker.isEnabled = available
        radiusPicker.selectItem(at: radii.firstIndex(of: working.localWarp.radiusCells) ?? 2)
        smoothnessPicker.isEnabled = available
        smoothnessPicker.selectItem(at: LocalWarpSmoothness.allCases.firstIndex(of: working.localWarp.smoothness) ?? 0)
        polynomialSummaryLabel.stringValue = "全局多项式：\(working.polynomial.enabled ? "已启用" : "未启用") · \(working.polynomial.order) 阶\n局部修正独立叠加，原系数保留。"
        anchorPicker.removeAllItems()
        anchorPicker.addItem(withTitle: "点击网格选择交点")
        for (index, anchor) in working.localWarp.anchors.enumerated() { anchorPicker.addItem(withTitle: String(format: "锚点 %02d · (%+.0f, %+.0f)", index + 1, anchor.x, anchor.y)) }
        if let selected = canvasView.selectedCoordinate {
            if let index = working.localWarp.anchors.firstIndex(where: { simd_length($0.coordinate - selected) < 0.0001 }) { anchorPicker.selectItem(at: index + 1) }
            let delta = LocalWarpEditingCoordinates.screenVector(LocalWarpField(working.localWarp).displacement(at: selected), configuration: working)
            selectionLabel.stringValue = String(format: "参考坐标：X %+.2f / Y %+.2f", selected.x, selected.y)
            offsetLabel.stringValue = String(format: "ΔX %+.2f px\nΔY %+.2f px", delta.x, delta.y)
            if let physical = canvasView.physicalPoint(for: selected) { pointLabel.stringValue = String(format: "已应用位置：X %.2f / Y %.2f 物理 px%@", Double(physical.x), Double(physical.y), pending ? " · 新请求待应用" : "") }
            else { pointLabel.stringValue = "选中锚点在当前画布外，数据仍保留。" }
            let locked = working.localWarp.boundaryWeight(at: selected) < 0.000001
            editButtons.forEach { $0.isEnabled = available && working.localWarp.enabled && !locked && canvasView.physicalPoint(for: selected) != nil }
            editButtons.last?.isEnabled = available && working.localWarp.anchor(at: selected) != nil
            if locked && available { statusLabel.stringValue = "该点在锁定参考边界上或外侧；解锁后才能调整。" }
        } else {
            selectionLabel.stringValue = "点击网格交点进行选择"
            offsetLabel.stringValue = "ΔX — / ΔY —"
            pointLabel.stringValue = "下方为交点放大图：灰十字＝基础位置，橙点＝已应用位置。"
            editButtons.forEach { $0.isEnabled = false }
        }
        if let reference = working.localWarp.reference {
            referenceLabel.stringValue = String(format: "冻结参考格距：%.2f × %.2f 逻辑单位\n参考域：%.0f × %.0f；锚点 %d/64", reference.cellWidth, reference.cellHeight, reference.bounds.maximumX - reference.bounds.minimumX, reference.bounds.maximumY - reference.bounds.minimumY, working.localWarp.anchors.count)
        }
    }

    private func submit(_ local: LocalWarpConfiguration, recordHistory: Bool = true) {
        guard available else { return }
        guard local != working.localWarp else { return }
        if let error = local.validationErrors().first { statusLabel.stringValue = error; statusLabel.textColor = .systemRed; refresh(); return }
        working.localWarp = local
        pending = true
        statusLabel.stringValue = "正在验证新网格；外屏保持上一有效画面，验证通过后自动保存。"
        statusLabel.textColor = .systemOrange
        refresh()
        onChange?(local, recordHistory)
    }

    func nudge(dx: Double, dy: Double, isRepeat: Bool = false) {
        guard available, working.localWarp.enabled, let selected = canvasView.selectedCoordinate,
              canvasView.physicalPoint(for: selected) != nil,
              working.localWarp.boundaryWeight(at: selected) >= 0.000001 else { return }
        var local = working.localWarp
        var offset = LocalWarpField(local).displacement(at: selected)
        if local.anchor(at: selected) == nil, let rendered = canvasView.physicalPoint(for: selected) {
            if !working.alignment.isGeometricEnabled {
                // Preserve the legacy exact rendered-point anchoring when no alignment is active.
                var base = working
                base.localWarp.enabled = false
                let physicalBase = WarpMath.physicalPoints(canvasPoints: [base.canvasUV(for: selected)], configuration: base)[0]
                let difference = rendered - physicalBase
                offset = LocalWarpEditingCoordinates.modelVector(SIMD2(Double(difference.x), Double(difference.y)), configuration: working)
            } else if canvasView.configuration?.localWarp == local {
                // Retain subpixel mesh interpolation error without subtracting two differently
                // aligned surfaces. Disabling local warp can change the global alignment itself.
                let analytic = WarpMath.physicalPoints(canvasPoints: [working.canvasUV(for: selected)], configuration: working)[0]
                let residual = rendered - analytic
                offset += LocalWarpEditingCoordinates.modelVector(SIMD2(Double(residual.x), Double(residual.y)), configuration: working)
            }
        }
        let delta = LocalWarpEditingCoordinates.modelVector(SIMD2(dx, dy), configuration: working)
        local.setOffset(offset + delta, at: selected)
        submit(local, recordHistory: !isRepeat)
    }

    private func direction(_ code: UInt16, modifiers: NSEvent.ModifierFlags, repeated: Bool) {
        let step = modifiers.contains(.option) ? 0.1 : modifiers.contains(.shift) ? 10 : steps[max(stepPicker.indexOfSelectedItem, 0)]
        switch code {
        case 123: nudge(dx: -step, dy: 0, isRepeat: repeated)
        case 124: nudge(dx: step, dy: 0, isRepeat: repeated)
        case 125: nudge(dx: 0, dy: step, isRepeat: repeated)
        case 126: nudge(dx: 0, dy: -step, isRepeat: repeated)
        default: break
        }
    }

    @objc private func focusCanvas() { canvasView.window?.makeFirstResponder(canvasView) }
    @objc private func movePoint(_ sender: NSButton) { direction(UInt16(sender.tag), modifiers: NSApp.currentEvent?.modifierFlags ?? [], repeated: false); focusCanvas() }
    @objc private func toggleEnabled() { var local = working.localWarp; local.enabled = enabledButton.state == .on; submit(local); focusCanvas() }
    @objc private func toggleBoundary() { var local = working.localWarp; local.lockBoundary = boundaryButton.state == .on; submit(local); focusCanvas() }
    @objc private func changeRadius() { var local = working.localWarp; local.radiusCells = radii[max(radiusPicker.indexOfSelectedItem, 0)]; submit(local); focusCanvas() }
    @objc private func changeSmoothness() { var local = working.localWarp; local.smoothness = LocalWarpSmoothness.allCases[max(smoothnessPicker.indexOfSelectedItem, 0)]; submit(local); focusCanvas() }
    @objc private func showPolynomial() { onShowPolynomial?() }
    @objc private func selectSavedAnchor() { let index = anchorPicker.indexOfSelectedItem - 1; if working.localWarp.anchors.indices.contains(index) { select(working.localWarp.anchors[index].coordinate) }; focusCanvas() }
    @objc private func resetPoint() { guard let selected = canvasView.selectedCoordinate else { return }; var local = working.localWarp; local.setOffset(.zero, at: selected); submit(local); focusCanvas() }
    @objc private func removePoint() { guard let selected = canvasView.selectedCoordinate else { return }; var local = working.localWarp; local.anchors.removeAll { simd_length($0.coordinate - selected) < 0.0001 }; submit(local); focusCanvas() }
    @objc private func undo() { onUndo?(); focusCanvas() }
    @objc private func zoomIn() { canvasView.changeZoom(by: 2); focusCanvas() }
    @objc private func zoomOut() { canvasView.changeZoom(by: 0.5); focusCanvas() }
    @objc private func fit() { canvasView.fit(); focusCanvas() }
    func windowWillClose(_ notification: Notification) { if !isEmbedded { onClose?() } }

    private static func builtInScreen() -> NSScreen? {
        NSScreen.screens.first { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
            return CGDisplayIsBuiltin(number.uint32Value) != 0
        }
    }

    func windowDidChangeScreen(_ notification: Notification) {
        guard let window, window.isVisible, let screen = Self.builtInScreen(), window.screen !== screen else { return }
        let visible = screen.visibleFrame
        window.setFrameOrigin(NSPoint(x: visible.midX - window.frame.width / 2, y: visible.midY - window.frame.height / 2))
    }
}
