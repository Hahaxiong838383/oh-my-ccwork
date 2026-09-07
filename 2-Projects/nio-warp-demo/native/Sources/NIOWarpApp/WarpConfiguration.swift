import Foundation

enum NumericInput {
    private static let groupingCharacters = [",", "，", " ", "\u{00A0}", "\u{202F}"]

    static func normalized(_ value: String) -> String {
        groupingCharacters.reduce(value.trimmingCharacters(in: .whitespacesAndNewlines)) {
            $0.replacingOccurrences(of: $1, with: "")
        }
    }

    static func integer(from value: String) -> Int? {
        let normalizedValue = normalized(value)
        if let integer = Int(normalizedValue) { return integer }
        guard let double = Double(normalizedValue), double.isFinite,
              double.rounded() >= Double(Int.min), double.rounded() < Double(Int.max) else { return nil }
        return Int(double.rounded())
    }

    static func double(from value: String) -> Double? {
        guard let result = Double(normalized(value)), result.isFinite else { return nil }
        return result
    }

    static func formattedDouble(_ value: Double) -> String {
        var result = String(format: "%.8f", locale: Locale(identifier: "en_US_POSIX"), value)
        while result.last == "0" { result.removeLast() }
        if result.last == "." { result.removeLast() }
        return result == "-0" ? "0" : result
    }
}
import simd

enum ContentMode: String, Codable, CaseIterable {
    case fit
    case fill
    case stretch

    var title: String {
        switch self {
        case .fit: return "保持比例·完整显示"
        case .fill: return "保持比例·铺满裁切（推荐）"
        case .stretch: return "拉伸铺满（调试，不推荐）"
        }
    }

    var shaderValue: Int32 {
        switch self {
        case .fit: return 0
        case .fill: return 1
        case .stretch: return 2
        }
    }
}

enum CaptureSourceMode: String, Codable, CaseIterable {
    case entireDisplay
    case automaticFullscreenWindow

    var title: String {
        switch self {
        case .entireDisplay: return "整个外接屏幕"
        case .automaticFullscreenWindow: return "自动跟随全屏窗口（推荐）"
        }
    }
}

struct CaptureConfiguration: Codable, Equatable {
    var sourceMode = CaptureSourceMode.automaticFullscreenWindow
    var fullscreenCoverageThreshold = 0.82

    func sanitized() -> CaptureConfiguration {
        CaptureConfiguration(
            sourceMode: sourceMode,
            fullscreenCoverageThreshold: min(max(fullscreenCoverageThreshold, 0.5), 1)
        )
    }
}

enum AntiAliasingMode: String, Codable, CaseIterable {
    case off
    case performance
    case quality

    var title: String {
        switch self {
        case .off: return "关闭"
        case .performance: return "性能模式"
        case .quality: return "质量模式"
        }
    }

    var shaderValue: UInt32 {
        switch self {
        case .off: return 0
        case .performance: return 1
        case .quality: return 2
        }
    }

    static let enabledCases: [AntiAliasingMode] = [.performance, .quality]
}

enum TestPatternMode: String, Codable, CaseIterable {
    case off
    case calibrationGrid
    case antiAliasingComparison

    var title: String {
        switch self {
        case .off: return "关闭测试图"
        case .calibrationGrid: return "标定网格"
        case .antiAliasingComparison: return "抗锯齿 A/B"
        }
    }

    var shaderValue: UInt32 {
        switch self {
        case .off: return 0
        case .calibrationGrid: return 1
        case .antiAliasingComparison: return 2
        }
    }
}

enum WarpTrend: String, Codable, CaseIterable {
    case forward
    case inverse

    var title: String {
        switch self {
        case .forward: return "同向模拟（反射凸起）"
        case .inverse: return "反向预畸变（屏幕中凹两侧翘）"
        }
    }

    var displacementMultiplier: Float {
        self == .inverse ? -1 : 1
    }
}

struct NormalizedRect: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    static let full = NormalizedRect(x: 0, y: 0, width: 1, height: 1)

    func sanitized() -> NormalizedRect {
        let safeX = min(max(x, 0), 0.999)
        let safeY = min(max(y, 0), 0.999)
        return NormalizedRect(
            x: safeX,
            y: safeY,
            width: min(max(width, 0.001), 1 - safeX),
            height: min(max(height, 0.001), 1 - safeY)
        )
    }
}

struct CanvasConfiguration: Codable, Equatable {
    var width: Int
    var height: Int

    var aspect: Float { Float(width) / Float(max(height, 1)) }
}

struct CropAnchorConfiguration: Codable, Equatable {
    var horizontal = 0.0
    var vertical = 0.0

    func sanitized() -> CropAnchorConfiguration {
        CropAnchorConfiguration(
            horizontal: min(max(horizontal, -1), 1),
            vertical: min(max(vertical, -1), 1)
        )
    }
}

struct MirrorConfiguration: Codable, Equatable {
    var horizontal = false
    var vertical = false
}

struct RenderConfiguration: Codable, Equatable {
    var antiAliasingEnabled = true
    var antiAliasing = AntiAliasingMode.performance
    var automaticPerformanceFallback = true
    var testPattern = TestPatternMode.off
    var showAABoundary = false
    var showWarpBoundary = false

    private enum CodingKeys: String, CodingKey {
        case antiAliasingEnabled
        case antiAliasing
        case automaticPerformanceFallback
        case testPattern
        case showAABoundary
        case showWarpBoundary
    }

    init(
        antiAliasingEnabled: Bool = true,
        antiAliasing: AntiAliasingMode = .performance,
        automaticPerformanceFallback: Bool = true,
        testPattern: TestPatternMode = .off,
        showAABoundary: Bool = false,
        showWarpBoundary: Bool = false
    ) {
        self.antiAliasingEnabled = antiAliasingEnabled
        self.antiAliasing = antiAliasing == .off ? .performance : antiAliasing
        self.automaticPerformanceFallback = automaticPerformanceFallback
        self.testPattern = testPattern
        self.showAABoundary = showAABoundary
        self.showWarpBoundary = showWarpBoundary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let legacyMode = try container.decodeIfPresent(AntiAliasingMode.self, forKey: .antiAliasing) ?? .performance
        antiAliasingEnabled = try container.decodeIfPresent(Bool.self, forKey: .antiAliasingEnabled) ?? (legacyMode != .off)
        antiAliasing = legacyMode == .off ? .performance : legacyMode
        automaticPerformanceFallback = try container.decodeIfPresent(Bool.self, forKey: .automaticPerformanceFallback) ?? true
        testPattern = try container.decodeIfPresent(TestPatternMode.self, forKey: .testPattern) ?? .off
        showAABoundary = try container.decodeIfPresent(Bool.self, forKey: .showAABoundary) ?? false
        showWarpBoundary = try container.decodeIfPresent(Bool.self, forKey: .showWarpBoundary) ?? false
    }
}

struct ManualWarpParameters: Codable, Equatable {
    var enabled = true
    var strength = 1.0
    var arch = 0.105
    var verticalScale = 0.83
    var asymmetry = 0.08
    var tilt = 0.025
    var horizontalBend = 0.018
}

struct PolynomialTerm: Equatable {
    let xPower: Int
    let yPower: Int

    var label: String {
        if xPower == 0 && yPower == 0 { return "1" }
        var parts = [String]()
        if xPower > 0 { parts.append(xPower == 1 ? "x" : "x^\(xPower)") }
        if yPower > 0 { parts.append(yPower == 1 ? "y" : "y^\(yPower)") }
        return parts.joined(separator: "·")
    }
}

struct PolynomialWarpConfiguration: Codable, Equatable {
    var enabled = false
    var order = 3
    var coefficientsX = Array(repeating: 0.0, count: 10)
    var coefficientsY = Array(repeating: 0.0, count: 10)

    static func terms(order: Int) -> [PolynomialTerm] {
        let safeOrder = min(max(order, 2), 5)
        var result = [PolynomialTerm]()
        for degree in 0...safeOrder {
            for yPower in 0...degree {
                result.append(PolynomialTerm(xPower: degree - yPower, yPower: yPower))
            }
        }
        return result
    }

    static func coefficientCount(order: Int) -> Int {
        terms(order: order).count
    }

    func evaluate(x: Double, y: Double, coefficients: [Double]) -> Double {
        zip(Self.terms(order: order), coefficients).reduce(0) { partial, pair in
            partial + pair.1 * pow(x, Double(pair.0.xPower)) * pow(y, Double(pair.0.yPower))
        }
    }

    func normalized() -> PolynomialWarpConfiguration {
        var copy = self
        copy.order = min(max(order, 2), 5)
        let count = Self.coefficientCount(order: copy.order)
        copy.coefficientsX = Array(coefficientsX.prefix(count)) + Array(repeating: 0, count: max(0, count - coefficientsX.count))
        copy.coefficientsY = Array(coefficientsY.prefix(count)) + Array(repeating: 0, count: max(0, count - coefficientsY.count))
        return copy
    }
}

struct WarpConfiguration: Codable, Equatable {
    static let currentSchemaVersion = 8

    var schemaVersion = currentSchemaVersion
    var displayPixelWidth: Int
    var displayPixelHeight: Int
    var aaRect: NormalizedRect
    var canvas: CanvasConfiguration
    var capture = CaptureConfiguration()
    var cropAnchor = CropAnchorConfiguration()
    var mirror = MirrorConfiguration()
    var contentMode = ContentMode.fill
    var extendedWarpEnabled = false
    var canvasReference: CanvasWarpReference?
    var warpTrend = WarpTrend.forward
    var manual = ManualWarpParameters()
    var polynomial = PolynomialWarpConfiguration()
    var render = RenderConfiguration()

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case displayPixelWidth
        case displayPixelHeight
        case aaRect
        case canvas
        case capture
        case cropAnchor
        case mirror
        case contentMode
        case extendedWarpEnabled
        case canvasReference
        case warpTrend
        case manual
        case polynomial
        case render
    }

    init(
        schemaVersion: Int = currentSchemaVersion,
        displayPixelWidth: Int,
        displayPixelHeight: Int,
        aaRect: NormalizedRect,
        canvas: CanvasConfiguration,
        capture: CaptureConfiguration = CaptureConfiguration(),
        cropAnchor: CropAnchorConfiguration = CropAnchorConfiguration(),
        mirror: MirrorConfiguration = MirrorConfiguration(),
        contentMode: ContentMode = .fill,
        extendedWarpEnabled: Bool = false,
        canvasReference: CanvasWarpReference? = nil,
        warpTrend: WarpTrend = .forward,
        manual: ManualWarpParameters = ManualWarpParameters(),
        polynomial: PolynomialWarpConfiguration = PolynomialWarpConfiguration(),
        render: RenderConfiguration = RenderConfiguration()
    ) {
        self.schemaVersion = schemaVersion
        self.displayPixelWidth = displayPixelWidth
        self.displayPixelHeight = displayPixelHeight
        self.aaRect = aaRect
        self.canvas = canvas
        self.capture = capture
        self.cropAnchor = cropAnchor
        self.mirror = mirror
        self.contentMode = contentMode
        self.extendedWarpEnabled = extendedWarpEnabled
        self.canvasReference = canvasReference
        self.warpTrend = warpTrend
        self.manual = manual
        self.polynomial = polynomial
        self.render = render
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        displayPixelWidth = try container.decode(Int.self, forKey: .displayPixelWidth)
        displayPixelHeight = try container.decode(Int.self, forKey: .displayPixelHeight)
        aaRect = try container.decode(NormalizedRect.self, forKey: .aaRect)
        canvas = try container.decode(CanvasConfiguration.self, forKey: .canvas)
        capture = try container.decodeIfPresent(CaptureConfiguration.self, forKey: .capture) ?? CaptureConfiguration()
        cropAnchor = try container.decodeIfPresent(CropAnchorConfiguration.self, forKey: .cropAnchor) ?? CropAnchorConfiguration()
        mirror = try container.decodeIfPresent(MirrorConfiguration.self, forKey: .mirror) ?? MirrorConfiguration()
        contentMode = try container.decodeIfPresent(ContentMode.self, forKey: .contentMode) ?? .stretch
        extendedWarpEnabled = try container.decodeIfPresent(Bool.self, forKey: .extendedWarpEnabled) ?? false
        canvasReference = try container.decodeIfPresent(CanvasWarpReference.self, forKey: .canvasReference)
        warpTrend = try container.decodeIfPresent(WarpTrend.self, forKey: .warpTrend) ?? .forward
        manual = try container.decodeIfPresent(ManualWarpParameters.self, forKey: .manual) ?? ManualWarpParameters()
        polynomial = try container.decodeIfPresent(PolynomialWarpConfiguration.self, forKey: .polynomial) ?? PolynomialWarpConfiguration()
        render = try container.decodeIfPresent(RenderConfiguration.self, forKey: .render) ?? RenderConfiguration()
    }

    static func defaultConfiguration(displayWidth: Int, displayHeight: Int) -> WarpConfiguration {
        WarpConfiguration(
            displayPixelWidth: displayWidth,
            displayPixelHeight: displayHeight,
            aaRect: NormalizedRect(x: 0.06, y: 0.26, width: 0.88, height: 0.48),
            canvas: CanvasConfiguration(width: 7680, height: 936)
        )
    }

    func sanitized(forDisplayWidth width: Int, height: Int) -> WarpConfiguration {
        var copy = self
        if copy.schemaVersion < 2 {
            let usesLegacyDefaultAA = abs(copy.aaRect.x - 0.06) < 0.000_001
                && abs(copy.aaRect.y - 0.18) < 0.000_001
                && abs(copy.aaRect.width - 0.88) < 0.000_001
                && abs(copy.aaRect.height - 0.48) < 0.000_001
            if usesLegacyDefaultAA {
                copy.aaRect.y = 0.26
                if copy.contentMode == .fit { copy.contentMode = .stretch }
            }
        }
        if copy.schemaVersion < 4, copy.contentMode == .stretch {
            copy.contentMode = .fill
        }
        copy.schemaVersion = Self.currentSchemaVersion
        copy.displayPixelWidth = width
        copy.displayPixelHeight = height
        copy.aaRect = copy.aaRect.sanitized()
        copy.canvas.width = min(max(copy.canvas.width, 64), 32768)
        copy.canvas.height = min(max(copy.canvas.height, 64), 32768)
        copy.capture = copy.capture.sanitized()
        copy.cropAnchor = copy.cropAnchor.sanitized()
        copy.manual.strength = min(max(copy.manual.strength, 0), 2)
        copy.manual.verticalScale = min(max(copy.manual.verticalScale, 0.2), 2)
        copy.polynomial = copy.polynomial.normalized()
        if copy.extendedWarpEnabled, copy.canvasReference == nil {
            copy.canvasReference = WarpMath.captureCanvasReference(configuration: copy, preservingLegacyExtension: schemaVersion <= 7)
        }
        return copy
    }

    func validationErrors() -> [String] {
        var errors = [String]()
        if schemaVersion < 1 || schemaVersion > Self.currentSchemaVersion {
            errors.append("不支持的 schemaVersion：\(schemaVersion)")
        }
        if displayPixelWidth <= 0 || displayPixelHeight <= 0 { errors.append("显示器像素尺寸必须大于 0") }
        if canvas.width <= 0 || canvas.height <= 0 { errors.append("画布尺寸必须大于 0") }
        if let reference = canvasReference, !reference.isValid { errors.append("画布基准无效，请重新设置基准或导入有效配置") }
        if cropAnchor != cropAnchor.sanitized() { errors.append("裁切位置必须位于 -1...1") }
        if aaRect != aaRect.sanitized() { errors.append("AA 区必须完全位于屏幕归一化范围内") }
        let normalizedPolynomial = polynomial.normalized()
        if polynomial.order != normalizedPolynomial.order { errors.append("多项式阶数仅支持 2–5 阶") }
        let expected = PolynomialWarpConfiguration.coefficientCount(order: normalizedPolynomial.order)
        if polynomial.coefficientsX.count != expected || polynomial.coefficientsY.count != expected {
            errors.append("\(normalizedPolynomial.order) 阶多项式的 X/Y 系数必须各有 \(expected) 项")
        }
        if polynomial.coefficientsX.contains(where: { !$0.isFinite }) || polynomial.coefficientsY.contains(where: { !$0.isFinite }) {
            errors.append("多项式系数不能包含 NaN 或 Infinity")
        }
        return errors
    }
}

extension WarpConfiguration {
    func rawReflectionCalibrationConfiguration() -> WarpConfiguration {
        var copy = self
        copy.contentMode = .fill
        copy.manual.enabled = false
        copy.polynomial.enabled = false
        copy.extendedWarpEnabled = false
        copy.render.testPattern = .calibrationGrid
        return copy
    }

    func antiAliasingComparisonConfiguration() -> WarpConfiguration {
        var copy = rawReflectionCalibrationConfiguration()
        copy.render.antiAliasingEnabled = true
        copy.render.testPattern = .antiAliasingComparison
        return copy
    }
}

final class ConfigurationStore {
    private let legacyKey = "nioWarpConfiguration.v1"
    private let profileKeyPrefix = "nioWarpConfiguration.v2"
    private let defaults: UserDefaults
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()
    private var activeKey: String

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        activeKey = legacyKey
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    func load(
        displayIdentifier: String = "default",
        displayWidth: Int,
        displayHeight: Int
    ) -> WarpConfiguration {
        activeKey = profileKey(for: displayIdentifier)
        if let configuration = decodedConfiguration(forKey: activeKey) {
            return persistSanitized(configuration, displayWidth: displayWidth, displayHeight: displayHeight)
        }

        if let legacy = decodedConfiguration(forKey: legacyKey),
           legacy.displayPixelWidth == displayWidth,
           legacy.displayPixelHeight == displayHeight {
            return persistSanitized(legacy, displayWidth: displayWidth, displayHeight: displayHeight)
        }

        let configuration = WarpConfiguration.defaultConfiguration(displayWidth: displayWidth, displayHeight: displayHeight)
        save(configuration)
        return configuration
    }

    func save(_ configuration: WarpConfiguration) {
        guard let data = try? encoder.encode(configuration) else { return }
        defaults.set(data, forKey: activeKey)
    }

    private func profileKey(for displayIdentifier: String) -> String {
        let safeIdentifier = displayIdentifier.map { character in
            character.isLetter || character.isNumber || character == "-" ? character : "-"
        }
        return "\(profileKeyPrefix).\(String(safeIdentifier))"
    }

    private func decodedConfiguration(forKey key: String) -> WarpConfiguration? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? decoder.decode(WarpConfiguration.self, from: data)
    }

    private func persistSanitized(
        _ configuration: WarpConfiguration,
        displayWidth: Int,
        displayHeight: Int
    ) -> WarpConfiguration {
        let sanitized = configuration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        if sanitized != configuration || defaults.data(forKey: activeKey) == nil { save(sanitized) }
        return sanitized
    }

    func exportData(_ configuration: WarpConfiguration) throws -> Data {
        try encoder.encode(configuration)
    }

    func importData(
        _ data: Data,
        baseConfiguration: WarpConfiguration? = nil,
        displayWidth: Int,
        displayHeight: Int
    ) throws -> WarpConfiguration {
        if let decoded = try? decoder.decode(WarpConfiguration.self, from: data) {
            let errors = decoded.validationErrors()
            guard errors.isEmpty else {
                throw NSError(domain: "NIOWarp.Configuration", code: 1, userInfo: [NSLocalizedDescriptionKey: errors.joined(separator: "\n")])
            }
            return decoded.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        }

        if let polynomial = try? decoder.decode(PolynomialWarpConfiguration.self, from: data) {
            let normalized = polynomial.normalized()
            guard polynomial.order == normalized.order,
                  polynomial.coefficientsX.count == normalized.coefficientsX.count,
                  polynomial.coefficientsY.count == normalized.coefficientsY.count,
                  !polynomial.coefficientsX.contains(where: { !$0.isFinite }),
                  !polynomial.coefficientsY.contains(where: { !$0.isFinite }) else {
                throw NSError(domain: "NIOWarp.Configuration", code: 2, userInfo: [NSLocalizedDescriptionKey: "多项式文件的阶数、系数数量或数值无效"])
            }
            var configuration = baseConfiguration ?? .defaultConfiguration(displayWidth: displayWidth, displayHeight: displayHeight)
            configuration.polynomial = normalized
            return configuration.sanitized(forDisplayWidth: displayWidth, height: displayHeight)
        }

        throw NSError(domain: "NIOWarp.Configuration", code: 3, userInfo: [NSLocalizedDescriptionKey: "文件既不是完整 Warp 配置，也不是多项式配置"])
    }
}
