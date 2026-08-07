#!/usr/bin/env swift
import AppKit
import Foundation
import Vision

func usage() -> Never {
    fputs("usage: ocr_macos.swift IMAGE [language ...]\n", stderr)
    exit(64)
}

guard CommandLine.arguments.count >= 2 else { usage() }
let path = CommandLine.arguments[1]
let languages = CommandLine.arguments.count > 2 ? Array(CommandLine.arguments.dropFirst(2)) : ["zh-Hans", "en-US"]
let url = URL(fileURLWithPath: path)
guard let image = NSImage(contentsOf: url) else {
    fputs("cannot load image: \(path)\n", stderr)
    exit(66)
}
var rect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    fputs("cannot create CGImage\n", stderr)
    exit(65)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = languages
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

print("x\ty\twidth\theight\tconfidence\ttext")
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    print(String(format: "%.6f\t%.6f\t%.6f\t%.6f\t%.4f\t%@",
                 box.origin.x, box.origin.y, box.size.width, box.size.height,
                 candidate.confidence, candidate.string))
}
