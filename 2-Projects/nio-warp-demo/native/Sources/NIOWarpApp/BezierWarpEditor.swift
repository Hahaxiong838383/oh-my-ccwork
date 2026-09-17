import AppKit
import simd

/// All distances in this editor are output-display physical pixels. AppKit points
/// are converted through the fitted surface scale, never through the local Retina scale.
final class BezierWarpCanvasView: NSView {
    private(set) var configuration: WarpConfiguration?
    private(set) var selectedIndex: Int?
    var editable = true
    var showsBaseline = true { didSet { needsDisplay = true } }
    var onSelect: ((Int?) -> Void)?
    var onDraft: ((BezierWarpConfiguration, Bool) -> Void)?
    var onDirection: ((UInt16, NSEvent.ModifierFlags, Bool) -> Void)?
    var onUndo: (() -> Void)?
    private var currentLines = [[SIMD2<Float>]]()
    private var baselineLines = [[SIMD2<Float>]]()
    private var controlLines = [[SIMD2<Float>]]()
    private var nodePoints = [SIMD2<Float>]()
    private var physicalBounds = NSRect(x: 0, y: 0, width: 5000, height: 1500)
    private var fitted = false
    private var zoom: CGFloat = 1
    private var dragStart: NSPoint?
    private var dragConfiguration: WarpConfiguration?
    private var dragHandle: Handle?
    private var alignmentAngle: Double = 0

    struct Handle {
        let horizontal: Bool
        let sign: Double
        let interval: Double
        let point: SIMD2<Float>
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityIdentifier("nio-bezier-canvas")
        setAccessibilityLabel("贝塞尔曲面预览；点击控制点，拖动节点或橙色切线手柄")
    }
    required init?(coder: NSCoder) { nil }

    func update(configuration: WarpConfiguration) {
        self.configuration = configuration
        if let selectedIndex, !configuration.bezierWarp.nodes.indices.contains(selectedIndex) { self.selectedIndex = nil }
        rebuildGeometry()
        if !fitted { fit() }
        needsDisplay = true
    }

    func selectNode(_ index: Int?) {
        selectedIndex = index.flatMap { configuration?.bezierWarp.nodes.indices.contains($0) == true ? $0 : nil }
        needsDisplay = true
    }

    func cancelInteraction() { dragStart = nil; dragConfiguration = nil; dragHandle = nil }

    private func rebuildGeometry() {
        guard let config = configuration else { return }
        alignmentAngle = Self.rotationAngle(for: config)
        var coordinates = [[SIMD2<Float>]]()
        for row in 0...12 { coordinates.append((0...96).map { SIMD2(Float($0) / 96, Float(row) / 12) }) }
        for column in 0...24 { coordinates.append((0...64).map { SIMD2(Float(column) / 24, Float($0) / 64) }) }
        var controlCoordinates = [[SIMD2<Float>]]()
        for vertical in config.bezierWarp.verticalKnots { controlCoordinates.append((0...96).map { SIMD2(Float($0) / 96, Float(vertical)) }) }
        for horizontal in config.bezierWarp.horizontalKnots { controlCoordinates.append((0...64).map { SIMD2(Float(horizontal), Float($0) / 64) }) }
        func mapped(_ lines: [[SIMD2<Float>]], _ configuration: WarpConfiguration) -> [[SIMD2<Float>]] {
            let points = WarpMath.physicalPoints(canvasPoints: lines.flatMap { $0 }, configuration: configuration)
            var offset = 0
            return lines.map { line in defer { offset += line.count }; return Array(points[offset..<(offset + line.count)]) }
        }
        currentLines = mapped(coordinates, config)
        controlLines = mapped(controlCoordinates, config)
        var base = config
        base.bezierWarp.enabled = false
        baselineLines = mapped(coordinates, base)
        nodePoints = WarpMath.physicalPoints(canvasPoints: config.bezierWarp.nodes.indices.map {
            let point = config.bezierWarp.coordinate(at: $0)
            return SIMD2(Float(point.x), Float(point.y))
        }, configuration: config)
    }

    func fit() {
        let points = (currentLines + baselineLines).flatMap { $0 }.filter { $0.x.isFinite && $0.y.isFinite }
        guard let first = points.first else { return }
        var minimum = first, maximum = first
        for point in points { minimum = simd_min(minimum, point); maximum = simd_max(maximum, point) }
        let width = max(CGFloat(maximum.x - minimum.x), 100)
        let height = max(CGFloat(maximum.y - minimum.y), 100)
        physicalBounds = NSRect(x: CGFloat(minimum.x) - width * 0.10, y: CGFloat(minimum.y) - height * 0.18, width: width * 1.20, height: height * 1.36)
        fitted = true
        zoom = 1
        needsDisplay = true
    }

    private var scale: CGFloat {
        max(0.000_001, min(max(bounds.width - 40, 1) / physicalBounds.width, max(bounds.height - 40, 1) / physicalBounds.height) * zoom)
    }

    func viewPoint(for physical: SIMD2<Float>) -> NSPoint {
        NSPoint(x: bounds.midX + (CGFloat(physical.x) - physicalBounds.midX) * scale, y: bounds.midY + (CGFloat(physical.y) - physicalBounds.midY) * scale)
    }

    func physicalDelta(forViewDelta delta: NSPoint) -> SIMD2<Double> { SIMD2(Double(delta.x / scale), Double(delta.y / scale)) }
    private static func rotationAngle(for configuration: WarpConfiguration) -> Double {
        guard configuration.alignment.level else { return 0 }
        var raw = configuration
        raw.alignment.centerHorizontal = false; raw.alignment.centerVertical = false; raw.alignment.level = false
        let axis = WarpMath.physicalPoints(canvasPoints: [SIMD2(0, 0.5), SIMD2(1, 0.5)], configuration: raw)
        let direction = axis[1] - axis[0]
        return simd_length(direction) > 0.0001 ? -Double(atan2(direction.y, direction.x)) : 0
    }
    private static func rotate(_ vector: SIMD2<Double>, angle: Double) -> SIMD2<Double> {
        SIMD2(cos(angle) * vector.x - sin(angle) * vector.y, sin(angle) * vector.x + cos(angle) * vector.y)
    }
    func modelDelta(forPhysicalDelta delta: SIMD2<Double>) -> SIMD2<Double> { Self.rotate(delta, angle: -alignmentAngle) }
    func changeZoom(by factor: CGFloat) { zoom = min(max(zoom * factor, 0.25), 16); needsDisplay = true }

    /// A cubic Bézier handle is P ± dP/du × adjacent knot interval / 3.
    /// The base surface derivative is included, so straight grids start with
    /// meaningful handles instead of arbitrary decorative handle lengths.
    func handles(at index: Int) -> [Handle] {
        guard let config = configuration, config.bezierWarp.nodes.indices.contains(index), nodePoints.indices.contains(index) else { return [] }
        let field = config.bezierWarp
        let coordinate = field.coordinate(at: index)
        let row = index / field.columns, column = index % field.columns
        var base = config
        base.bezierWarp.enabled = false
        base.alignment.centerHorizontal = false; base.alignment.centerVertical = false; base.alignment.level = false
        let epsilon = 0.0005
        let left = max(0, coordinate.x - epsilon), right = min(1, coordinate.x + epsilon)
        let top = max(0, coordinate.y - epsilon), bottom = min(1, coordinate.y + epsilon)
        let samples = WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(left), Float(coordinate.y)), SIMD2(Float(right), Float(coordinate.y)), SIMD2(Float(coordinate.x), Float(top)), SIMD2(Float(coordinate.x), Float(bottom))], configuration: base)
        let baseU = (samples[1] - samples[0]) / Float(right - left)
        let baseV = (samples[3] - samples[2]) / Float(bottom - top)
        let node = field.nodes[index]
        let rotatedU = Self.rotate(SIMD2(Double(baseU.x), Double(baseU.y)) + node.tangentU, angle: alignmentAngle)
        let rotatedV = Self.rotate(SIMD2(Double(baseV.x), Double(baseV.y)) + node.tangentV, angle: alignmentAngle)
        let tangentU = SIMD2(Float(rotatedU.x), Float(rotatedU.y))
        let tangentV = SIMD2(Float(rotatedV.x), Float(rotatedV.y))
        return [true, false].flatMap { horizontal -> [Handle] in
            let knots = horizontal ? field.horizontalKnots : field.verticalKnots
            let knotIndex = horizontal ? column : row
            return [-1.0, 1.0].compactMap { sign -> Handle? in
                // Only handles belonging to an actual adjacent patch are shown.
                guard sign < 0 ? knotIndex > 0 : knotIndex + 1 < knots.count else { return nil }
                let interval = sign < 0 ? knots[knotIndex] - knots[knotIndex - 1] : knots[knotIndex + 1] - knots[knotIndex]
                let vector = (horizontal ? tangentU : tangentV) * Float(sign * interval / 3)
                return Handle(horizontal: horizontal, sign: sign, interval: interval, point: nodePoints[index] + vector)
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        dragHandle = nil
        if let selectedIndex {
            dragHandle = handles(at: selectedIndex).first { handle in
                let candidate = viewPoint(for: handle.point)
                return hypot(candidate.x - point.x, candidate.y - point.y) <= 10
            }
        }
        if dragHandle == nil {
            let nearest = nodePoints.indices.min { lhs, rhs in
                let a = viewPoint(for: nodePoints[lhs]), b = viewPoint(for: nodePoints[rhs])
                return hypot(a.x - point.x, a.y - point.y) < hypot(b.x - point.x, b.y - point.y)
            }
            if let nearest {
                let candidate = viewPoint(for: nodePoints[nearest])
                if hypot(candidate.x - point.x, candidate.y - point.y) <= 16 { selectNode(nearest); onSelect?(nearest) }
                else { selectNode(nil); onSelect?(nil) }
            }
        }
        guard editable, configuration?.bezierWarp.enabled == true, selectedIndex != nil else { return }
        dragStart = point
        dragConfiguration = configuration
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart, var candidate = dragConfiguration, let selectedIndex else { return }
        let point = convert(event.locationInWindow, from: nil)
        let screenDelta = physicalDelta(forViewDelta: NSPoint(x: point.x - start.x, y: point.y - start.y))
        let delta = Self.rotate(screenDelta, angle: -Self.rotationAngle(for: candidate))
        let changed: Bool
        if let handle = dragHandle {
            let tangentDelta = delta * (3 / (handle.sign * handle.interval))
            changed = candidate.bezierWarp.applyTangentDelta(tangentDelta, axis: handle.horizontal ? .horizontal : .vertical, at: selectedIndex)
        } else { changed = candidate.bezierWarp.applyOffsetDelta(delta, at: selectedIndex) }
        guard changed, candidate.bezierWarp.validationErrors().isEmpty else { return }
        update(configuration: candidate)
        onDraft?(candidate.bezierWarp, false)
    }

    override func mouseUp(with event: NSEvent) {
        defer { dragStart = nil; dragConfiguration = nil; dragHandle = nil }
        guard let start = dragConfiguration, let current = configuration, start.bezierWarp != current.bezierWarp else { return }
        onDraft?(current.bezierWarp, true)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53, let start = dragConfiguration {
            dragStart = nil; dragConfiguration = nil; dragHandle = nil
            update(configuration: start); onDraft?(start.bezierWarp, false)
            return
        }
        if (123...126).contains(event.keyCode) { onDirection?(event.keyCode, event.modifierFlags, event.isARepeat); return }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "z" { onUndo?(); return }
        super.keyDown(with: event)
    }
    override func magnify(with event: NSEvent) { changeZoom(by: max(0.25, 1 + event.magnification)) }

    private func path(_ points: [SIMD2<Float>]) -> NSBezierPath {
        let path = NSBezierPath()
        var started = false
        for point in points where point.x.isFinite && point.y.isFinite {
            let view = viewPoint(for: point)
            if started { path.line(to: view) } else { path.move(to: view); started = true }
        }
        return path
    }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSBezierPath(rect: bounds).addClip()
        NSColor(calibratedRed: 0.045, green: 0.061, blue: 0.074, alpha: 1).setFill(); bounds.fill()
        guard let config = configuration else { return }
        if let selectedIndex, config.bezierWarp.enabled {
            let field = config.bezierWarp, selected = field.coordinate(at: selectedIndex)
            let entire = field.scope == .wholeCanvas
            let minX = max(0, selected.x - field.horizontalRadius)
            let maxX = min(1, selected.x + field.horizontalRadius)
            let minY = entire ? 0 : max(0, selected.y - field.verticalRadius)
            let maxY = entire ? 1 : min(1, selected.y + field.verticalRadius)
            let corners = [SIMD2(minX, minY), SIMD2(maxX, minY), SIMD2(maxX, maxY), SIMD2(minX, maxY), SIMD2(minX, minY)]
            let outline = (0..<4).flatMap { edge in (0...30).map { step -> SIMD2<Float> in
                let p = corners[edge] + (corners[edge + 1] - corners[edge]) * (Double(step) / 30)
                return SIMD2(Float(p.x), Float(p.y))
            } }
            let region = path(WarpMath.physicalPoints(canvasPoints: outline, configuration: config))
            region.close()
            NSColor.systemCyan.withAlphaComponent(0.08).setFill(); region.fill()
        }
        if showsBaseline {
            for line in baselineLines {
                let curve = path(line); curve.lineWidth = 0.7; curve.setLineDash([3, 4], count: 2, phase: 0)
                NSColor.white.withAlphaComponent(0.19).setStroke(); curve.stroke()
            }
        }
        for line in currentLines { let curve = path(line); curve.lineWidth = 0.8; NSColor.white.withAlphaComponent(0.5).setStroke(); curve.stroke() }
        for line in controlLines { let curve = path(line); curve.lineWidth = 1.35; NSColor.systemCyan.withAlphaComponent(config.bezierWarp.enabled ? 0.85 : 0.35).setStroke(); curve.stroke() }
        let aa = config.aaRect
        let aaPoints = [SIMD2(Float(aa.x * Double(config.displayPixelWidth)), Float(aa.y * Double(config.displayPixelHeight))), SIMD2(Float((aa.x + aa.width) * Double(config.displayPixelWidth)), Float((aa.y + aa.height) * Double(config.displayPixelHeight)))]
        let a = viewPoint(for: aaPoints[0]), b = viewPoint(for: aaPoints[1])
        let reference = NSBezierPath(rect: NSRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y))
        reference.lineWidth = 1; reference.setLineDash([7, 5], count: 2, phase: 0)
        NSColor.systemYellow.withAlphaComponent(0.42).setStroke(); reference.stroke()
        if let selectedIndex, nodePoints.indices.contains(selectedIndex), config.bezierWarp.enabled {
            let origin = viewPoint(for: nodePoints[selectedIndex])
            for handle in handles(at: selectedIndex) {
                let end = viewPoint(for: handle.point)
                let line = NSBezierPath(); line.move(to: origin); line.line(to: end); line.lineWidth = 1.2
                NSColor.systemOrange.withAlphaComponent(0.8).setStroke(); line.stroke()
                let dot = NSBezierPath(rect: NSRect(x: end.x - 4, y: end.y - 4, width: 8, height: 8))
                NSColor.systemOrange.setFill(); dot.fill()
            }
        }
        for (index, physical) in nodePoints.enumerated() {
            let point = viewPoint(for: physical), selected = selectedIndex == index
            let radius: CGFloat = selected ? 6 : 4
            if selected { NSColor.systemOrange.withAlphaComponent(0.16).setFill(); NSBezierPath(ovalIn: NSRect(x: point.x - 13, y: point.y - 13, width: 26, height: 26)).fill() }
            (selected ? NSColor.systemOrange : NSColor.systemCyan).setFill()
            NSBezierPath(ovalIn: NSRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)).fill()
            if selected {
                let label = "P\(index % config.bezierWarp.columns + 1) · R\(index / config.bezierWarp.columns + 1)"
                label.draw(at: NSPoint(x: point.x + 11, y: point.y - 20), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.systemOrange])
            }
        }
        let caption = !editable ? "只读预览 · 连接外屏并启动正常 Warp 输出后可编辑" : config.bezierWarp.enabled ? "节点与切线共同驱动二维曲面 · 网格为真实数学变形预览" : "贝塞尔修正未启用 · 显示当前整体 Warp 基线"
        caption.draw(at: NSPoint(x: 16, y: 15), withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: editable ? NSColor.white.withAlphaComponent(0.65) : NSColor.systemOrange])
    }
}

private final class BezierEditorDocument: NSView { override var isFlipped: Bool { true } }

final class BezierWarpEditorController: NSWindowController, NSWindowDelegate {
    var onChange: ((BezierWarpConfiguration, Bool) -> Void)?
    var onUndo: (() -> Void)?
    var onClose: (() -> Void)?
    let canvasView = BezierWarpCanvasView()
    private var working: WarpConfiguration
    private var available: Bool
    private let enabledButton = NSButton(checkboxWithTitle: "启用贝塞尔曲面叠加", target: nil, action: nil)
    private let baselineButton = NSButton(checkboxWithTitle: "叠显原始整体 Warp（灰色虚线）", target: nil, action: nil)
    private let summaryLabel = NSTextField(wrappingLabelWithString: "")
    private let selectionLabel = NSTextField(wrappingLabelWithString: "请选择控制点")
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let columnsField = NSTextField(string: "5")
    private let rowsField = NSTextField(string: "3")
    private let offsetXField = NSTextField(string: "0")
    private let offsetYField = NSTextField(string: "0")
    private let radiusXField = NSTextField(string: "50")
    private let radiusYField = NSTextField(string: "100")
    private let scopePicker = NSPopUpButton()
    private let linkagePicker = NSPopUpButton()
    private let stepPicker = NSPopUpButton()
    private var mutableControls = [NSControl]()
    private var selectedControls = [NSControl]()
    var draftConfiguration: WarpConfiguration { working }
    var statusText: String { statusLabel.stringValue }

    init(configuration: WarpConfiguration, available: Bool) {
        working = configuration
        self.available = available
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 790), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "NIO Warp · 贝塞尔曲面与分区趋势"
        window.minSize = NSSize(width: 1040, height: 650)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        super.init(window: window)
        window.delegate = self
        buildInterface()
        synchronize(configuration: configuration, available: available)
        window.center()
    }
    required init?(coder: NSCoder) { nil }

    func showStatus(_ message: String, error: Bool = false) { statusLabel.stringValue = message; statusLabel.textColor = error ? .systemRed : .secondaryLabelColor }

    func synchronize(configuration: WarpConfiguration, available: Bool, message: String? = nil) {
        working = configuration
        self.available = available
        canvasView.cancelInteraction()
        canvasView.editable = available
        canvasView.update(configuration: configuration)
        refresh()
        showStatus(message ?? (available ? "拖动时为本地预览；释放后校验曲面，非法折叠不会替换有效输出。" : "当前为只读预览；启动正常校正后可编辑。"))
    }

    private func text(_ value: String, heading: Bool = false) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.preferredMaxLayoutWidth = 266
        label.font = .systemFont(ofSize: heading ? 13 : 11, weight: heading ? .semibold : .regular)
        label.textColor = heading ? .labelColor : .secondaryLabelColor
        return label
    }
    private func button(_ title: String, _ action: Selector, id: String? = nil) -> NSButton {
        let control = NSButton(title: title, target: self, action: action)
        control.bezelStyle = .rounded
        if let id { control.setAccessibilityIdentifier(id) }
        return control
    }
    private func row(_ views: [NSView]) -> NSStackView { let stack = NSStackView(views: views); stack.spacing = 6; return stack }
    private func buildInterface() {
        guard let content = window?.contentView else { return }
        let sidebar = NSScrollView()
        sidebar.hasVerticalScroller = true; sidebar.autohidesScrollers = true; sidebar.drawsBackground = false
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        let document = BezierEditorDocument(); document.translatesAutoresizingMaskIntoConstraints = false; sidebar.documentView = document
        document.widthAnchor.constraint(equalTo: sidebar.contentView.widthAnchor).isActive = true
        let controls = NSStackView(); controls.orientation = .vertical; controls.alignment = .leading; controls.spacing = 11
        controls.edgeInsets = NSEdgeInsets(top: 12, left: 4, bottom: 20, right: 12)
        controls.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(controls)
        NSLayoutConstraint.activate([controls.leadingAnchor.constraint(equalTo: document.leadingAnchor), controls.trailingAnchor.constraint(equalTo: document.trailingAnchor), controls.topAnchor.constraint(equalTo: document.topAnchor), controls.bottomAnchor.constraint(equalTo: document.bottomAnchor)])
        let right = NSView(); right.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(sidebar); content.addSubview(right)
        NSLayoutConstraint.activate([sidebar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16), sidebar.topAnchor.constraint(equalTo: content.topAnchor, constant: 12), sidebar.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12), sidebar.widthAnchor.constraint(equalToConstant: 302), right.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: 14), right.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16), right.topAnchor.constraint(equalTo: content.topAnchor, constant: 16), right.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16)])
        let title = text("整体参数保持 · 以节点和切线塑造整片画面", heading: true)
        let legend = text("青色＝控制网　橙色圆点＝节点　橙色方点＝切线手柄　黄色＝AA 边界")
        title.preferredMaxLayoutWidth = 0
        legend.preferredMaxLayoutWidth = 0
        let instructions = NSTextField(wrappingLabelWithString: "1 选择区域与联动方式 → 2 拖节点改变位置 → 3 拖切线改变曲率 → 4 释放并校验\n方向键精调；Shift 10 px，Option 0.1 px；Command-Z 撤销。物理像素不随本机 Retina 倍率变化。")
        instructions.font = .systemFont(ofSize: 11); instructions.textColor = .secondaryLabelColor
        let viewButtons = row([button("−", #selector(zoomOut)), button("＋", #selector(zoomIn)), button("适合窗口", #selector(fit))])
        for view in [title, canvasView, legend, instructions, viewButtons] { view.translatesAutoresizingMaskIntoConstraints = false; right.addSubview(view) }
        NSLayoutConstraint.activate([title.leadingAnchor.constraint(equalTo: right.leadingAnchor), title.topAnchor.constraint(equalTo: right.topAnchor), viewButtons.trailingAnchor.constraint(equalTo: right.trailingAnchor), viewButtons.centerYAnchor.constraint(equalTo: title.centerYAnchor), canvasView.leadingAnchor.constraint(equalTo: right.leadingAnchor), canvasView.trailingAnchor.constraint(equalTo: right.trailingAnchor), canvasView.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14), canvasView.bottomAnchor.constraint(equalTo: legend.topAnchor, constant: -10), legend.leadingAnchor.constraint(equalTo: right.leadingAnchor), legend.bottomAnchor.constraint(equalTo: instructions.topAnchor, constant: -8), instructions.leadingAnchor.constraint(equalTo: right.leadingAnchor), instructions.trailingAnchor.constraint(equalTo: right.trailingAnchor), instructions.bottomAnchor.constraint(equalTo: right.bottomAnchor)])
        title.trailingAnchor.constraint(lessThanOrEqualTo: viewButtons.leadingAnchor, constant: -12).isActive = true
        legend.trailingAnchor.constraint(equalTo: right.trailingAnchor).isActive = true

        controls.addArrangedSubview(text("整体 Warp 基础", heading: true))
        summaryLabel.font = .monospacedSystemFont(ofSize: 12, weight: .medium); summaryLabel.preferredMaxLayoutWidth = 270
        controls.addArrangedSubview(summaryLabel)
        enabledButton.target = self; enabledButton.action = #selector(toggleEnabled); enabledButton.setAccessibilityIdentifier("nio-bezier-enabled")
        controls.addArrangedSubview(enabledButton)
        controls.addArrangedSubview(text("此处叠加曲面修正，不改写基础强度、上下弧度和局部交点。关闭后保留控制网数据。"))
        controls.addArrangedSubview(text("控制网密度", heading: true))
        for (field, id) in [(columnsField, "columns"), (rowsField, "rows"), (offsetXField, "offset-x"), (offsetYField, "offset-y"), (radiusXField, "radius-x"), (radiusYField, "radius-y")] {
            field.widthAnchor.constraint(equalToConstant: 62).isActive = true
            field.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            field.setAccessibilityIdentifier("nio-bezier-" + id)
        }
        let resize = button("应用", #selector(resizeGrid), id: "nio-bezier-resize")
        controls.addArrangedSubview(row([text("每行"), columnsField, text("点 ×"), rowsField, text("行"), resize]))
        let addColumn = button("＋ 控制点列", #selector(insertColumn), id: "nio-bezier-add-column")
        let addRow = button("＋ 控制行", #selector(insertRow), id: "nio-bezier-add-row")
        controls.addArrangedSubview(row([addColumn, addRow]))
        controls.addArrangedSubview(text("每行 2–9 点，共 2–7 行。增加节点保持当前曲面；减少已调节点需确认重建。点击节点选择要细分的相邻区域。"))
        controls.addArrangedSubview(text("联动范围", heading: true))
        scopePicker.addItems(withTitles: ["指定分区", "贯穿画面 · 联动全部行"]); scopePicker.target = self; scopePicker.action = #selector(changeSettings); scopePicker.setAccessibilityIdentifier("nio-bezier-scope")
        linkagePicker.addItems(withTitles: ["渐变联动 · 平滑衰减", "等量联动 · 区域同移"]); linkagePicker.target = self; linkagePicker.action = #selector(changeSettings); linkagePicker.setAccessibilityIdentifier("nio-bezier-linkage")
        controls.addArrangedSubview(scopePicker); controls.addArrangedSubview(linkagePicker)
        radiusXField.target = self; radiusXField.action = #selector(changeSettings)
        radiusYField.target = self; radiusYField.action = #selector(changeSettings)
        controls.addArrangedSubview(row([text("横向半径 %"), radiusXField, text("纵向半径 %"), radiusYField]))
        controls.addArrangedSubview(text("半径按画面宽高计，从选中点向两侧延伸。贯穿模式仍保留横向分区；100% 横向半径可带动全幅。淡青色为联动选点范围，曲面平滑过渡至相邻未修改行列。"))
        controls.addArrangedSubview(text("选中节点 · 物理像素", heading: true))
        selectionLabel.font = .monospacedSystemFont(ofSize: 12, weight: .medium); selectionLabel.preferredMaxLayoutWidth = 270; selectionLabel.setAccessibilityIdentifier("nio-bezier-selection")
        controls.addArrangedSubview(selectionLabel)
        let setOffset = button("设置", #selector(setOffset), id: "nio-bezier-set-offset")
        controls.addArrangedSubview(row([text("ΔX"), offsetXField, text("ΔY"), offsetYField, setOffset]))
        stepPicker.addItems(withTitles: ["0.1 px", "1 px", "10 px"]); stepPicker.selectItem(at: 1)
        controls.addArrangedSubview(row([text("方向键步长"), stepPicker]))
        let reset = button("复位选中节点与切线", #selector(resetNode), id: "nio-bezier-reset-node")
        let resetAll = button("清空曲面修正", #selector(resetAll), id: "nio-bezier-reset-all")
        let undo = button("撤销上一次设置 ⌘Z", #selector(undo), id: "nio-bezier-undo")
        controls.addArrangedSubview(reset); controls.addArrangedSubview(row([resetAll, undo]))
        baselineButton.state = .on; baselineButton.target = self; baselineButton.action = #selector(toggleBaseline)
        controls.addArrangedSubview(baselineButton)
        statusLabel.font = .systemFont(ofSize: 11); statusLabel.preferredMaxLayoutWidth = 270; statusLabel.setAccessibilityIdentifier("nio-bezier-status")
        controls.addArrangedSubview(statusLabel)
        mutableControls = [enabledButton, columnsField, rowsField, resize, addColumn, addRow, scopePicker, linkagePicker, radiusXField, radiusYField, resetAll, undo]
        selectedControls = [offsetXField, offsetYField, setOffset, reset]
        canvasView.onSelect = { [weak self] index in self?.selectNode(index) }
        canvasView.onDraft = { [weak self] value, finished in
            guard let self else { return }
            self.working.bezierWarp = value
            self.refresh()
            if finished {
                self.showStatus("正在验证曲面；通过后应用，失败时保留上一有效输出。")
                self.onChange?(value, true)
            } else { self.showStatus("本地拖动预览中 · 释放后验证与提交，Escape 取消本次拖动。") }
        }
        canvasView.onDirection = { [weak self] code, modifiers, repeated in self?.direction(code, modifiers: modifiers, repeated: repeated) }
        canvasView.onUndo = { [weak self] in self?.onUndo?() }
    }

    private func refresh() {
        let field = working.bezierWarp
        enabledButton.state = field.enabled ? .on : .off
        summaryLabel.stringValue = String(format: "Warp 强度 %.3f\n输出 %d × %d px · 控制点 %d", working.manual.strength, working.displayPixelWidth, working.displayPixelHeight, field.nodes.count)
        columnsField.stringValue = "\(field.columns)"; rowsField.stringValue = "\(field.rows)"
        scopePicker.selectItem(at: field.scope == .wholeCanvas ? 1 : 0)
        linkagePicker.selectItem(at: field.linkage == .uniform ? 1 : 0)
        radiusXField.stringValue = NumericInput.formattedDouble(field.horizontalRadius * 100)
        radiusYField.stringValue = NumericInput.formattedDouble(field.verticalRadius * 100)
        mutableControls.forEach { $0.isEnabled = available }
        radiusXField.isEnabled = available
        radiusYField.isEnabled = available && field.scope == .region
        let selected = canvasView.selectedIndex.flatMap { field.nodes.indices.contains($0) ? $0 : nil }
        selectedControls.forEach { $0.isEnabled = available && field.enabled && selected != nil }
        if let selected {
            let node = field.nodes[selected]
            selectionLabel.stringValue = "第 \(selected / field.columns + 1) 行 · 第 \(selected % field.columns + 1) 点\n手柄：水平 / 垂直切线，平滑连接相邻面片"
            offsetXField.stringValue = NumericInput.formattedDouble(node.offset.x)
            offsetYField.stringValue = NumericInput.formattedDouble(node.offset.y)
        } else { selectionLabel.stringValue = "点击青色节点，再拖动圆点或切线方点"; offsetXField.stringValue = "0"; offsetYField.stringValue = "0" }
    }

    func selectNode(_ index: Int?) { canvasView.selectNode(index); refresh() }

    private func submit(_ field: BezierWarpConfiguration, recordHistory: Bool = true) {
        guard available, field != working.bezierWarp else { return }
        if let error = field.validationErrors().first { showStatus(error, error: true); return }
        working.bezierWarp = field
        canvasView.update(configuration: working)
        refresh()
        showStatus("正在验证曲面；通过后应用，失败时保留上一有效输出。")
        onChange?(field, recordHistory)
    }

    func nudge(dx: Double, dy: Double, isRepeat: Bool = false) {
        guard available, working.bezierWarp.enabled, let selected = canvasView.selectedIndex else { return }
        var field = working.bezierWarp
        guard field.applyOffsetDelta(canvasView.modelDelta(forPhysicalDelta: SIMD2(dx, dy)), at: selected) else { return }
        submit(field, recordHistory: !isRepeat)
    }

    private func direction(_ code: UInt16, modifiers: NSEvent.ModifierFlags, repeated: Bool) {
        let steps = [0.1, 1.0, 10.0]
        let step = modifiers.contains(.option) ? 0.1 : modifiers.contains(.shift) ? 10 : steps[max(0, stepPicker.indexOfSelectedItem)]
        switch code {
        case 123: nudge(dx: -step, dy: 0, isRepeat: repeated)
        case 124: nudge(dx: step, dy: 0, isRepeat: repeated)
        case 125: nudge(dx: 0, dy: step, isRepeat: repeated)
        case 126: nudge(dx: 0, dy: -step, isRepeat: repeated)
        default: break
        }
    }

    @objc private func toggleEnabled() { var field = working.bezierWarp; field.enabled = enabledButton.state == .on; submit(field) }
    @objc private func toggleBaseline() { canvasView.showsBaseline = baselineButton.state == .on }
    @objc private func changeSettings() {
        guard let horizontal = NumericInput.double(from: radiusXField.stringValue), let vertical = NumericInput.double(from: radiusYField.stringValue), horizontal >= 5, horizontal <= 100, vertical >= 5, vertical <= 100 else { showStatus("范围请输入 5–100%，表示从选中节点向两侧延伸的半径。", error: true); return }
        var field = working.bezierWarp
        field.scope = scopePicker.indexOfSelectedItem == 1 ? .wholeCanvas : .region
        field.linkage = linkagePicker.indexOfSelectedItem == 1 ? .uniform : .gradient
        field.horizontalRadius = horizontal / 100; field.verticalRadius = vertical / 100
        submit(field)
    }
    @objc private func setOffset() {
        guard let index = canvasView.selectedIndex, let x = NumericInput.double(from: offsetXField.stringValue), let y = NumericInput.double(from: offsetYField.stringValue) else { showStatus("节点位移请输入有限数字，单位为输出物理像素。", error: true); return }
        var field = working.bezierWarp
        guard field.applyOffsetDelta(SIMD2(x, y) - field.nodes[index].offset, at: index) else { showStatus("位移超出允许范围。", error: true); return }
        submit(field)
    }
    @objc private func resizeGrid() {
        guard let columns = Int(columnsField.stringValue), let rows = Int(rowsField.stringValue) else { showStatus("控制点数量与行数必须是整数。", error: true); return }
        var field = working.bezierWarp
        if field.resize(columns: columns, rows: rows) { selectNode(nil); submit(field); return }
        // The model refuses destructive reduction unless explicitly authorized.
        guard columns >= 2, rows >= 2, columns <= 9, rows <= 7, columns < field.columns || rows < field.rows else { showStatus("请输入每行 2–9 点，共 2–7 行。", error: true); refresh(); return }
        let alert = NSAlert(); alert.messageText = "减少控制网密度并重建曲面？"
        alert.informativeText = "减少节点会清除当前贝塞尔修正并重建规则控制网。整体 Warp 与已有局部交点保留；本次操作可撤销。"
        alert.addButton(withTitle: "取消"); alert.addButton(withTitle: "重建控制网")
        guard alert.runModal() == .alertSecondButtonReturn else { refresh(); return }
        guard field.resize(columns: columns, rows: rows, allowReset: true) else { showStatus("无法重建：控制点数量超出允许范围。", error: true); refresh(); return }
        selectNode(nil); submit(field)
    }
    private func insertionPoint(_ knots: [Double], index: Int?) -> Double {
        if let index { let left = min(index, knots.count - 2); return (knots[left] + knots[left + 1]) / 2 }
        var largest = 0
        for candidate in 1..<(knots.count - 1) {
            let candidateGap = knots[candidate + 1] - knots[candidate]
            let largestGap = knots[largest + 1] - knots[largest]
            if candidateGap > largestGap { largest = candidate }
        }
        return (knots[largest] + knots[largest + 1]) / 2
    }
    @objc private func insertColumn() {
        var field = working.bezierWarp
        let index = canvasView.selectedIndex.map { $0 % field.columns }
        guard field.insertColumn(at: insertionPoint(field.horizontalKnots, index: index)) else { showStatus("无法添加列：已到控制网数量上限。", error: true); return }
        selectNode(nil); submit(field)
    }
    @objc private func insertRow() {
        var field = working.bezierWarp
        let index = canvasView.selectedIndex.map { $0 / field.columns }
        guard field.insertRow(at: insertionPoint(field.verticalKnots, index: index)) else { showStatus("无法添加行：已到控制网数量上限。", error: true); return }
        selectNode(nil); submit(field)
    }
    @objc private func resetNode() {
        guard let index = canvasView.selectedIndex else { return }
        var field = working.bezierWarp
        field.nodes[index].offset = .zero; field.nodes[index].tangentU = .zero; field.nodes[index].tangentV = .zero; field.nodes[index].mixedDerivative = .zero
        submit(field)
    }
    @objc private func resetAll() {
        var field = working.bezierWarp
        for index in field.nodes.indices { field.nodes[index].offset = .zero; field.nodes[index].tangentU = .zero; field.nodes[index].tangentV = .zero; field.nodes[index].mixedDerivative = .zero }
        submit(field)
    }
    @objc private func undo() { onUndo?() }
    @objc private func zoomIn() { canvasView.changeZoom(by: 1.5) }
    @objc private func zoomOut() { canvasView.changeZoom(by: 1 / 1.5) }
    @objc private func fit() { canvasView.fit() }
    func windowWillClose(_ notification: Notification) { onClose?() }
}
