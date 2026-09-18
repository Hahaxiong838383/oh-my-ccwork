import AppKit
import CryptoKit
import ImageIO

/// Artwork availability is independent of the validated page's input session.
/// These errors never contain CSS, resource URLs or source response bodies.
enum ProtoPieCursorArtworkError: String, LocalizedError {
    case invalidCSS, resourceUnavailable, invalidImage

    var errorDescription: String? {
        switch self {
        case .invalidCSS: return "播放器原有鼠标样式暂不可读。"
        case .resourceUnavailable: return "播放器原有鼠标资源暂不可用。"
        case .invalidImage: return "播放器原有鼠标图片暂不可用。"
        }
    }
}

/// The player's original CSS artwork and hotspot, carried by the output window.
/// No replacement artwork is generated and no resource URL enters diagnostics.
@MainActor struct ProtoPieCursorStyle {
    let cursor: NSCursor?
    let isHidden: Bool
    let identifier: String
    let imageSize: CGSize
    let hotSpot: CGPoint

    static let maximumResourceBytes = 128 * 1024
    static let maximumImageDimension = 128
    static let maximumImagePixels = 256

    static func decode(_ definition: ProtoPieCursorDefinition, imageData: Data? = nil) throws -> Self {
        if definition.resource != nil {
            guard let data = imageData, !data.isEmpty, data.count <= maximumResourceBytes,
                  let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  CGImageSourceGetCount(source) == 1,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else { throw invalid() }
            let w = width.intValue, h = height.intValue
            let density = definition.density
            let logicalWidth = Double(w) / density, logicalHeight = Double(h) / density
            guard (1...maximumImagePixels).contains(w), (1...maximumImagePixels).contains(h),
                  density.isFinite, density > 0, logicalWidth.isFinite, logicalHeight.isFinite,
                  logicalWidth >= 1, logicalWidth <= Double(maximumImageDimension),
                  logicalHeight >= 1, logicalHeight <= Double(maximumImageDimension),
                  definition.hotSpot.x.isFinite, definition.hotSpot.y.isFinite,
                  definition.hotSpot.x >= 0, definition.hotSpot.x < logicalWidth,
                  definition.hotSpot.y >= 0, definition.hotSpot.y < logicalHeight,
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw invalid() }
            let size = CGSize(width: logicalWidth, height: logicalHeight)
            let cursor = NSCursor(image: NSImage(cgImage: image, size: size), hotSpot: definition.hotSpot)
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            return Self(cursor: cursor, isHidden: false,
                        identifier: "css-image-sha256:\(digest):density=\(density):hotspot=\(definition.hotSpot.x),\(definition.hotSpot.y)",
                        imageSize: size, hotSpot: definition.hotSpot)
        }
        if definition.keyword == "none" {
            return Self(cursor: nil, isHidden: true, identifier: "css:none", imageSize: .zero, hotSpot: .zero)
        }
        let cursor: NSCursor
        switch definition.keyword {
        case "pointer": cursor = .pointingHand
        case "text": cursor = .iBeam
        case "crosshair": cursor = .crosshair
        case "not-allowed", "no-drop": cursor = .operationNotAllowed
        case "grab": cursor = .openHand
        case "grabbing": cursor = .closedHand
        case "ew-resize", "col-resize": cursor = .resizeLeftRight
        case "ns-resize", "row-resize": cursor = .resizeUpDown
        default: cursor = .arrow
        }
        return Self(cursor: cursor, isHidden: false, identifier: "css:\(definition.keyword)",
                    imageSize: cursor.image.size, hotSpot: cursor.hotSpot)
    }

    static func invalid() -> ProtoPieCursorArtworkError {
        .invalidImage
    }
}

/// Computed cursor values are browser-normalized. Reject malformed image syntax
/// instead of quietly replacing a requested custom cursor with an invented one.
struct ProtoPieCursorDefinition {
    let resource: String?
    let hotSpot: CGPoint
    let keyword: String
    var density: Double = 1

    static func parse(_ css: String) throws -> Self {
        let value = css.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 192 * 1024 else { throw error() }
        if value.hasPrefix("image-set(") || value.hasPrefix("-webkit-image-set(") {
            let choices = try parseImageSet(value)
            guard let choice = choices.first(where: { $0.density == 1 }) ?? choices.min(by: { $0.density < $1.density }) else { throw error() }
            return choice
        }
        if !value.lowercased().hasPrefix("url(") {
            let keywords = ["auto", "default", "pointer", "text", "none", "crosshair", "help", "wait", "progress",
                            "not-allowed", "no-drop", "grab", "grabbing", "move", "all-scroll", "cell", "context-menu",
                            "vertical-text", "copy", "alias", "zoom-in", "zoom-out", "ew-resize", "col-resize",
                            "ns-resize", "row-resize", "n-resize", "s-resize", "e-resize", "w-resize",
                            "ne-resize", "nw-resize", "se-resize", "sw-resize", "nesw-resize", "nwse-resize"]
            guard keywords.contains(value) else { throw error() }
            return Self(resource: nil, hotSpot: .zero, keyword: value)
        }
        let number = #"([+-]?(?:\d+(?:\.\d*)?|\.\d+))"#
        let pattern = #"^url\(\s*(?:"([^"\\]+)"|'([^'\\]+)'|([^\)\s\\]+))\s*\)\s*(?:"#
            + number + #"\s+"# + number + #")?\s*,\s*([a-z-]+)\s*$"#
        let regex = try NSRegularExpression(pattern: pattern)
        let range = NSRange(value.startIndex..., in: value)
        guard let match = regex.firstMatch(in: value, range: range), match.range == range else { throw error() }
        func group(_ index: Int) -> String? {
            Range(match.range(at: index), in: value).map { String(value[$0]) }
        }
        guard let resource = group(1) ?? group(2) ?? group(3), !resource.isEmpty,
              let fallback = group(6), (try? parse(fallback)) != nil else { throw error() }
        let x = group(4).flatMap(Double.init) ?? 0, y = group(5).flatMap(Double.init) ?? 0
        guard x.isFinite, y.isFinite, x >= 0, y >= 0 else { throw error() }
        return Self(resource: resource, hotSpot: CGPoint(x: x, y: y), keyword: fallback)
    }

    /// Preserve every source-declared resource with its own density. A browser
    /// may already hold only the Retina member of an image-set in its cache.
    static func candidates(for css: String) throws -> [Self] {
        let value = css.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 192 * 1024 else { throw error() }
        if value.hasPrefix("image-set(") || value.hasPrefix("-webkit-image-set(") {
            return try parseImageSet(value)
        }
        return [try parse(value)]
    }

    private static func parseImageSet(_ value: String) throws -> [Self] {
        let number = #"([+-]?(?:\d+(?:\.\d*)?|\.\d+))"#
        let pattern = #"^(?:-webkit-)?image-set\((.*)\)\s*(?:"#
            + number + #"\s+"# + number + #")?\s*,\s*([a-z-]+)\s*$"#
        let regex = try NSRegularExpression(pattern: pattern)
        let range = NSRange(value.startIndex..., in: value)
        guard let match = regex.firstMatch(in: value, range: range), match.range == range else { throw error() }
        func group(_ index: Int) -> String? {
            Range(match.range(at: index), in: value).map { String(value[$0]) }
        }
        guard let body = group(1), let fallback = group(4), (try? parse(fallback)) != nil else { throw error() }
        let x = group(2).flatMap(Double.init) ?? 0, y = group(3).flatMap(Double.init) ?? 0
        guard x.isFinite, y.isFinite, x >= 0, y >= 0 else { throw error() }
        let entries = try imageSetEntries(body)
        let assetPattern = #"^\s*(url\(\s*(?:"[^"\\]+"|'[^'\\]+'|[^\)\s\\]+)\s*\))\s+"#
            + number + #"(?:dppx|x)\s*$"#
        let assetRegex = try NSRegularExpression(pattern: assetPattern)
        var choices = [Self]()
        for entry in entries {
            let entryRange = NSRange(entry.startIndex..., in: entry)
            guard let asset = assetRegex.firstMatch(in: entry, range: entryRange), asset.range == entryRange,
                  let urlRange = Range(asset.range(at: 1), in: entry),
                  let densityRange = Range(asset.range(at: 2), in: entry),
                  let density = Double(entry[densityRange]), density.isFinite, density > 0, density <= 8 else { throw error() }
            let parsed = try parse(String(entry[urlRange]) + ", " + fallback)
            choices.append(Self(resource: parsed.resource, hotSpot: CGPoint(x: x, y: y), keyword: fallback, density: density))
        }
        return choices
    }

    private static func imageSetEntries(_ body: String) throws -> [String] {
        var entries = [String](), current = ""
        var quote: Character?, depth = 0
        for character in body {
            guard character != "\\" else { throw error() }
            if let active = quote {
                current.append(character)
                if character == active { quote = nil }
                continue
            }
            if character == "\"" || character == "'" { quote = character }
            else if character == "(" { depth += 1 }
            else if character == ")" { depth -= 1; guard depth >= 0 else { throw error() } }
            else if character == ",", depth == 0 {
                entries.append(current); current = ""; continue
            }
            current.append(character)
        }
        guard quote == nil, depth == 0 else { throw error() }
        entries.append(current)
        guard (1...16).contains(entries.count) else { throw error() }
        return entries
    }

    private static func error() -> ProtoPieCursorArtworkError {
        .invalidCSS
    }
}
