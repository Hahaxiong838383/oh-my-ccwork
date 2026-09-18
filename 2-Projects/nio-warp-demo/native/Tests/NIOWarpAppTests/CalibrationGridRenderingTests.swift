import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

final class CalibrationGridRenderingTests: XCTestCase {
    private struct Image {
        let width: Int
        let height: Int
        let pixels: [UInt8]
        let gpuMilliseconds: Double

        func isWhite(column: Int, row: Int) -> Bool {
            let offset = (row * width + column) * 4
            let channels = pixels[offset..<(offset + 3)]
            return channels.min()! > 150 && Int(channels.max()!) - Int(channels.min()!) < 20
        }

        func circleBounds(in region: CGRect) -> CGRect? {
            var minimumX = width, minimumY = height, maximumX = -1, maximumY = -1
            let rows = min(height, max(0, Int(region.minY)))..<min(height, max(0, Int(region.maxY)))
            let columns = min(width, max(0, Int(region.minX)))..<min(width, max(0, Int(region.maxX)))
            for row in rows {
                for column in columns {
                    let offset = (row * width + column) * 4
                    // The amber ring is distinct from white grid lines and all four corner markers.
                    if pixels[offset + 2] > 210 && (165...200).contains(pixels[offset + 1]) && pixels[offset] < 50 {
                        minimumX = min(minimumX, column); maximumX = max(maximumX, column)
                        minimumY = min(minimumY, row); maximumY = max(maximumY, row)
                    }
                }
            }
            guard maximumX >= minimumX, maximumY >= minimumY else { return nil }
            return CGRect(x: minimumX, y: minimumY, width: maximumX - minimumX + 1, height: maximumY - minimumY + 1)
        }

        func bands(horizontal: Bool) -> [Range<Int>] {
            let length = horizontal ? width : height
            var result = [Range<Int>]()
            var start: Int?
            for position in 12..<(length - 12) {
                // Sample near the edge, outside the new nine-circle marker region.
                let white = isWhite(column: horizontal ? position : 8, row: horizontal ? 8 : position)
                if white && start == nil { start = position }
                if !white, let first = start { result.append(first..<position); start = nil }
            }
            if let first = start { result.append(first..<(length - 12)) }
            return result.filter { abs(Double($0.lowerBound + $0.upperBound) * 0.5 - Double(length) * 0.5) > 16 }
        }

        func save(_ name: String) throws {
            guard let directory = ProcessInfo.processInfo.environment["NIO_WARP_GRID_PREVIEW_DIR"] else { return }
            let folder = URL(fileURLWithPath: directory, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: width * 4, bitsPerPixel: 32
            ))
            var rgba = pixels
            for offset in stride(from: 0, to: rgba.count, by: 4) { rgba.swapAt(offset, offset + 2) }
            rgba.withUnsafeBytes { bytes in bitmap.bitmapData!.update(from: bytes.bindMemory(to: UInt8.self).baseAddress!, count: rgba.count) }
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: folder.appendingPathComponent(name))
        }
    }

    private func render(
        grid: CalibrationGridConfiguration = CalibrationGridConfiguration(columns: 8, rows: 4, lineWidthPixels: 4),
        scale: SIMD2<Float> = SIMD2(repeating: 1), smooth: Bool = true, patternMode: UInt32 = 1,
        shaderSource: String = WarpRenderer.shaderSource, width: Int = 400, height: Int = 240,
        mesh: GeneratedMesh? = nil, sourceMarker: Bool = false,
        geometryScale: SIMD2<Float> = SIMD2(repeating: 1), mirrorFlags: UInt32 = 0,
        referenceCanvas: CanvasConfiguration? = nil, configuration: WarpConfiguration? = nil
    ) throws -> Image {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("需要 Metal 设备") }
        let library = try device.makeLibrary(source: shaderSource, options: nil)
        let pipelineDescriptor = MTLRenderPipelineDescriptor()
        pipelineDescriptor.vertexFunction = library.makeFunction(name: "vertexMain")
        pipelineDescriptor.fragmentFunction = library.makeFunction(name: "fragmentMain")
        pipelineDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        let layout = MTLVertexDescriptor()
        layout.attributes[0].format = .float2
        layout.attributes[0].bufferIndex = 0
        layout.attributes[1].format = .float2
        layout.attributes[1].offset = MemoryLayout<SIMD2<Float>>.stride
        layout.attributes[1].bufferIndex = 0
        layout.layouts[0].stride = MemoryLayout<MeshVertex>.stride
        pipelineDescriptor.vertexDescriptor = layout
        let pipeline = try device.makeRenderPipelineState(descriptor: pipelineDescriptor)
        let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        textureDescriptor.storageMode = .shared
        textureDescriptor.usage = [.renderTarget, .shaderRead]
        let texture = try XCTUnwrap(device.makeTexture(descriptor: textureDescriptor))
        let sourceDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: sourceMarker ? width : 1, height: sourceMarker ? height : 1, mipmapped: false)
        sourceDescriptor.storageMode = .shared
        sourceDescriptor.usage = .shaderRead
        let source = try XCTUnwrap(device.makeTexture(descriptor: sourceDescriptor))
        if sourceMarker {
            var marker = [UInt8](repeating: 0, count: width * height * 4)
            for row in (height / 4 - 1)...(height / 4 + 1) {
                for column in (width / 4 - 1)...(width / 4 + 1) { marker[(row * width + column) * 4 + 2] = 255; marker[(row * width + column) * 4 + 3] = 255 }
            }
            source.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: marker, bytesPerRow: width * 4)
        } else {
            var black: UInt32 = 0xff000000
            source.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &black, bytesPerRow: 4)
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
        let command = try XCTUnwrap(device.makeCommandQueue()?.makeCommandBuffer())
        let encoder = try XCTUnwrap(command.makeRenderCommandEncoder(descriptor: pass))
        let extent = scale * geometryScale
        let vertices = [
            MeshVertex(position: SIMD2(-extent.x, extent.y), uv: SIMD2(0, 0)),
            MeshVertex(position: SIMD2(extent.x, extent.y), uv: SIMD2(1, 0)),
            MeshVertex(position: SIMD2(-extent.x, -extent.y), uv: SIMD2(0, 1)),
            MeshVertex(position: SIMD2(extent.x, -extent.y), uv: SIMD2(1, 1)),
        ]
        let actualVertices = mesh?.vertices ?? vertices
        let buffer = try XCTUnwrap(device.makeBuffer(bytes: actualVertices, length: actualVertices.count * MemoryLayout<MeshVertex>.stride))
        var circleConfiguration = configuration ?? WarpConfiguration.defaultConfiguration(displayWidth: width, displayHeight: height)
        if configuration == nil { circleConfiguration.canvas = referenceCanvas ?? CanvasConfiguration(width: width, height: height) }
        var uniforms = ShaderUniforms(
            sourceAspect: 1, canvasAspect: 1, contentMode: 0, mirrorFlags: mirrorFlags, cropAnchor: SIMD2(repeating: 0),
            sourceTexelSize: SIMD2(repeating: 1), antiAliasingMode: smooth ? 1 : 0, testPatternMode: patternMode,
            contentUVScale: SIMD2(repeating: 1), gridUVScale: scale, gridParameters: grid.shaderParameters,
            circleParameters: circleConfiguration.calibrationCircleParameters
        )
        XCTAssertEqual(MemoryLayout<ShaderUniforms>.stride, 96)
        encoder.setRenderPipelineState(pipeline)
        encoder.setVertexBuffer(buffer, offset: 0, index: 0)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<ShaderUniforms>.stride, index: 1)
        encoder.setFragmentTexture(source, index: 0)
        if let mesh {
            let indices = try XCTUnwrap(device.makeBuffer(bytes: mesh.indices, length: mesh.indices.count * MemoryLayout<UInt32>.stride))
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: mesh.indices.count, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
        } else {
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
        encoder.endEncoding()
        command.commit()
        command.waitUntilCompleted()
        XCTAssertEqual(command.status, .completed, command.error?.localizedDescription ?? "")
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        texture.getBytes(&pixels, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        return Image(width: width, height: height, pixels: pixels, gpuMilliseconds: (command.gpuEndTime - command.gpuStartTime) * 1000)
    }

    func testGPUGridParametersChangeActualWhiteRowAndColumnCounts() throws {
        let original = try render()
        let changed = try render(grid: CalibrationGridConfiguration(columns: 10, rows: 6, lineWidthPixels: 4))
        XCTAssertEqual(original.bands(horizontal: true).count, 6)
        XCTAssertEqual(original.bands(horizontal: false).count, 2)
        XCTAssertEqual(changed.bands(horizontal: true).count, 8)
        XCTAssertEqual(changed.bands(horizontal: false).count, 4)
        try original.save("grid-8-columns-4-rows.png")
        try changed.save("grid-10-columns-6-rows.png")
    }

    func testGPUWhiteLineWidthsFollowPhysicalPixelsWithAAOnAndOff() throws {
        for smooth in [false, true] {
            for width in [2.0, 4.0, 8.0] {
                let image = try render(grid: CalibrationGridConfiguration(columns: 8, rows: 4, lineWidthPixels: width), smooth: smooth)
                for band in image.bands(horizontal: true) + image.bands(horizontal: false) {
                    XCTAssertEqual(Double(band.count), width, accuracy: 1)
                }
                try image.save("line-\(Int(width))px-aa-\(smooth).png")
            }
        }
    }

    func testGPUCanvasGrowthPreservesOldGridSpacingAndLineWidth() throws {
        let original = try render()
        let expanded = try render(scale: SIMD2(1.6, 2))
        XCTAssertEqual(original.bands(horizontal: true), expanded.bands(horizontal: true))
        XCTAssertEqual(original.bands(horizontal: false), expanded.bands(horizontal: false))
        try expanded.save("expanded-fixed-pitch.png")
        if let path = ProcessInfo.processInfo.environment["NIO_WARP_GRID_BASELINE_SHADER"] {
            let baseline = try String(contentsOfFile: path, encoding: .utf8)
            var oldTimes = [Double]()
            var newTimes = [Double]()
            for iteration in 0..<24 {
                let oldFrame = try render(grid: CalibrationGridConfiguration(), shaderSource: baseline, width: 3840, height: 2160)
                let newFrame = try render(grid: CalibrationGridConfiguration(), width: 3840, height: 2160)
                if iteration >= 4 {
                    oldTimes.append(oldFrame.gpuMilliseconds)
                    newTimes.append(newFrame.gpuMilliseconds)
                }
            }
            oldTimes.sort()
            newTimes.sort()
            XCTAssertGreaterThan(oldTimes[10], 0)
            XCTAssertGreaterThan(newTimes[10], 0)
            print(String(format: "GRID_GPU_3840x2160 baseline median=%.3f p95=%.3f ms; current median=%.3f p95=%.3f ms; offscreen only", oldTimes[10], oldTimes[18], newTimes[10], newTimes[18]))
        }
    }

    func testAntialiasingDiagnosticIsUnaffectedByCalibrationGridSettings() throws {
        let original = try render(patternMode: 2)
        let changed = try render(grid: CalibrationGridConfiguration(columns: 37, rows: 13, lineWidthPixels: 12), patternMode: 2)
        XCTAssertEqual(original.pixels, changed.pixels)
    }

    func testNineGPUCirclesAreRoundInPixelSpaceOnUltraWideCanvas() throws {
        for smooth in [false, true] {
            let image = try render(smooth: smooth, width: 7680, height: 936)
            for row in 0..<3 {
                for column in 0..<3 {
                    let region = CGRect(x: column * 2560, y: row * 312, width: 2560, height: 312)
                    let ring = try XCTUnwrap(image.circleBounds(in: region), "缺少第\(row + 1)行第\(column + 1)列标定圆")
                    XCTAssertEqual(ring.midX, region.midX, accuracy: 1)
                    XCTAssertEqual(ring.midY, region.midY, accuracy: 1)
                    XCTAssertEqual(ring.width, ring.height, accuracy: 2)
                    XCTAssertGreaterThan(ring.width, 170)
                    XCTAssertLessThan(ring.width, 183)
                }
            }
            try image.save("nine-circles-7680x936-aa-\(smooth).png")
        }
    }

    func testGPUCirclesRevealCompressionAndStretchInsteadOfRemainingRound() throws {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 7680, displayHeight: 1872)
        configuration.canvas = CanvasConfiguration(width: 7680, height: 936)
        // A taller render target leaves room to measure stretching at the actual 5.5x limit.
        configuration.aaRect = NormalizedRect(x: 0, y: 0.25, width: 1, height: 0.5)
        configuration.manual = ManualWarpParameters(enabled: true, strength: 0, arch: 0, verticalScale: 1, asymmetry: 0, tilt: 0, horizontalBend: 0)
        for verticalScale in [0.12, 0.5, 1.0, 1.75, 5.5] {
            configuration.manual.verticalAspectScale = verticalScale
            let mesh = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
            XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
            let image = try render(width: 7680, height: 1872, mesh: mesh, configuration: configuration)
            for column in 0..<3 {
                let halfHeight = 100 * verticalScale + 8
                let ring = try XCTUnwrap(image.circleBounds(in: CGRect(x: Double(column * 2560), y: 936 - halfHeight, width: 2560, height: halfHeight * 2)))
                XCTAssertEqual(ring.midY, 936, accuracy: 1)
                // Stroke width is deliberately physical-pixel based, so compare centerline diameters.
                XCTAssertEqual((ring.height - 4) / (ring.width - 4), verticalScale, accuracy: 0.04)
            }
            try image.save("circle-vertical-scale-\(verticalScale).png")
        }
    }

    func testGPUCanvasExpansionPreservesNineCircleSizeAndPosition() throws {
        let reference = CanvasConfiguration(width: 7680, height: 936)
        let original = try render(width: 7680, height: 936, referenceCanvas: reference)
        let expanded = try render(scale: SIMD2(Float(13000) / 7680, Float(2800) / 936), width: 7680, height: 936, referenceCanvas: reference)
        for row in 0..<3 {
            for column in 0..<3 {
                let region = CGRect(x: column * 2560, y: row * 312, width: 2560, height: 312)
                let before = try XCTUnwrap(original.circleBounds(in: region))
                let after = try XCTUnwrap(expanded.circleBounds(in: region))
                XCTAssertEqual(before.midX, after.midX, accuracy: 1)
                XCTAssertEqual(before.midY, after.midY, accuracy: 1)
                XCTAssertEqual(before.width, after.width, accuracy: 2)
                XCTAssertEqual(before.height, after.height, accuracy: 2)
            }
        }
        try expanded.save("nine-circles-expanded-13000x2800.png")
    }

    func testLocalCorrectionMovesBothDesktopTextureAndCalibrationGridOnGPU() throws {
        var config = WarpConfiguration.defaultConfiguration(displayWidth: 400, displayHeight: 240)
        config.canvas = CanvasConfiguration(width: 400, height: 240)
        config.aaRect = NormalizedRect(x: 0, y: 0, width: 1, height: 1)
        config.manual.enabled = false
        config.render.calibrationGrid = CalibrationGridConfiguration(columns: 8, rows: 4, lineWidthPixels: 4)
        config = config.preparedForLocalEditing()
        config.localWarp.enabled = true
        let beforeMesh = WarpMath.makeMesh(configuration: config, columns: 192, rows: 72)
        config.localWarp.setOffset(SIMD2(6, 4), at: config.localCoordinate(at: SIMD2(0.25, 0.25)))
        let afterMesh = WarpMath.makeMesh(configuration: config, columns: 192, rows: 72)
        XCTAssertTrue(afterMesh.validation.isValid)
        let before = try render(smooth: false, patternMode: 0, mesh: beforeMesh, sourceMarker: true)
        let after = try render(smooth: false, patternMode: 0, mesh: afterMesh, sourceMarker: true)
        func center(_ image: Image) throws -> SIMD2<Double> {
            var sum = SIMD2<Double>.zero
            var count = 0.0
            for row in 0..<image.height {
                for column in 0..<image.width {
                    let offset = (row * image.width + column) * 4
                    if image.pixels[offset + 2] > 200 && image.pixels[offset + 1] < 20 {
                        sum += SIMD2(Double(column), Double(row)); count += 1
                    }
                }
            }
            XCTAssertGreaterThan(count, 0)
            return sum / max(count, 1)
        }
        let difference = try center(after) - center(before)
        XCTAssertEqual(difference.x, 6, accuracy: 1)
        XCTAssertEqual(difference.y, 4, accuracy: 1)
        let beforeGrid = try render(mesh: beforeMesh)
        let afterGrid = try render(mesh: afterMesh)
        XCTAssertFalse(beforeGrid.isWhite(column: 106, row: 64))
        XCTAssertTrue(afterGrid.isWhite(column: 106, row: 64))
        try before.save("local-texture-before.png")
        try after.save("local-texture-after.png")
        try afterGrid.save("local-grid-after.png")
    }
}
