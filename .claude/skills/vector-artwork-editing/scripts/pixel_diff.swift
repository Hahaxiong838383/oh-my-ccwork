#!/usr/bin/env swift
import AppKit
import CoreGraphics
import Foundation

struct Region {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    func contains(x px: Int, y py: Int, width w: Int, height h: Int) -> Bool {
        return px >= x && py >= y && px + w <= x + width && py + h <= y + height
    }
}

func usage() -> Never {
    fputs("usage: pixel_diff.swift BASELINE.png CANDIDATE.png [--output DIFF.png] [--threshold 0-255] [--expected x,y,w,h]\n", stderr)
    exit(64)
}

func parseRegion(_ value: String) -> Region? {
    let parts = value.split(separator: ",").compactMap { Int($0) }
    guard parts.count == 4, parts[2] >= 0, parts[3] >= 0 else { return nil }
    return Region(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

func loadRGBA(_ path: String) -> (width: Int, height: Int, pixels: [UInt8])? {
    guard let image = NSImage(contentsOfFile: path) else { return nil }
    var rect = NSRect(origin: .zero, size: image.size)
    guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
    let width = cg.width
    let height = cg.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(data: &pixels, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (width, height, pixels)
}

func saveRGBA(_ pixels: inout [UInt8], width: Int, height: Int, path: String) -> Bool {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(data: &pixels, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let cg = context.makeImage() else { return false }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let data = rep.representation(using: .png, properties: [:]) else { return false }
    do {
        try data.write(to: URL(fileURLWithPath: path))
        return true
    } catch {
        fputs("cannot write diff image: \(error)\n", stderr)
        return false
    }
}

guard CommandLine.arguments.count >= 3 else { usage() }
let baselinePath = CommandLine.arguments[1]
let candidatePath = CommandLine.arguments[2]
var outputPath: String? = nil
var threshold = 0
var expected: Region? = nil
var index = 3
while index < CommandLine.arguments.count {
    let option = CommandLine.arguments[index]
    guard index + 1 < CommandLine.arguments.count else { usage() }
    let value = CommandLine.arguments[index + 1]
    switch option {
    case "--output": outputPath = value
    case "--threshold":
        guard let parsed = Int(value), (0...255).contains(parsed) else { usage() }
        threshold = parsed
    case "--expected":
        guard let parsed = parseRegion(value) else { usage() }
        expected = parsed
    default: usage()
    }
    index += 2
}

guard let baseline = loadRGBA(baselinePath) else {
    fputs("cannot load baseline: \(baselinePath)\n", stderr)
    exit(66)
}
guard let candidate = loadRGBA(candidatePath) else {
    fputs("cannot load candidate: \(candidatePath)\n", stderr)
    exit(66)
}
guard baseline.width == candidate.width && baseline.height == candidate.height else {
    fputs("image dimensions differ: \(baseline.width)x\(baseline.height) vs \(candidate.width)x\(candidate.height)\n", stderr)
    exit(65)
}

let width = baseline.width
let height = baseline.height
var diff = [UInt8](repeating: 0, count: width * height * 4)
var changed = 0
var maxDelta = 0
var totalDelta: UInt64 = 0
var minX = width
var maxX = -1
var minYTop = height
var maxYTop = -1

for yBottom in 0..<height {
    let yTop = height - 1 - yBottom
    for x in 0..<width {
        let offset = (yBottom * width + x) * 4
        var pixelMax = 0
        var pixelSum = 0
        for channel in 0..<4 {
            let delta = abs(Int(baseline.pixels[offset + channel]) - Int(candidate.pixels[offset + channel]))
            pixelMax = max(pixelMax, delta)
            pixelSum += delta
        }
        if pixelMax > threshold {
            changed += 1
            maxDelta = max(maxDelta, pixelMax)
            totalDelta += UInt64(pixelSum)
            minX = min(minX, x)
            maxX = max(maxX, x)
            minYTop = min(minYTop, yTop)
            maxYTop = max(maxYTop, yTop)
            diff[offset] = UInt8(pixelMax)
            diff[offset + 1] = 0
            diff[offset + 2] = 0
            diff[offset + 3] = 255
        } else {
            diff[offset] = 0
            diff[offset + 1] = 0
            diff[offset + 2] = 0
            diff[offset + 3] = 255
        }
    }
}

var result: [String: Any] = [
    "width": width,
    "height": height,
    "threshold": threshold,
    "changed_pixels": changed,
    "changed_fraction": Double(changed) / Double(width * height),
    "max_channel_delta": maxDelta,
    "mean_rgba_delta_over_changed_pixels": changed > 0 ? Double(totalDelta) / Double(changed * 4) : 0.0
]

var insideExpected = true
if changed > 0 {
    let bboxWidth = maxX - minX + 1
    let bboxHeight = maxYTop - minYTop + 1
    result["bbox_top_left"] = ["x": minX, "y": minYTop, "width": bboxWidth, "height": bboxHeight]
    if let region = expected {
        insideExpected = region.contains(x: minX, y: minYTop, width: bboxWidth, height: bboxHeight)
        result["inside_expected_region"] = insideExpected
    }
} else {
    result["bbox_top_left"] = NSNull()
    if expected != nil { result["inside_expected_region"] = true }
}

if let output = outputPath {
    let parent = URL(fileURLWithPath: output).deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    guard saveRGBA(&diff, width: width, height: height, path: output) else { exit(74) }
    result["diff_image"] = output
}

let json = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(data: json, encoding: .utf8)!)
exit(insideExpected ? 0 : 2)
