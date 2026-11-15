//
//  LetterTextPlugin.swift
//  NeuralConnexions: the words on a photographed letter, read on the iPhone with Apple's Vision.
//
//  JavaScript (registerPlugin("LetterText")):
//    read({ path }) -> { text: string, lines: number }
//      path: a photo's file path or file:// URL, as @capacitor/camera gives it (Photo.path), or a shared photo's
//      path from SharedInbox.list().
//
//  The text reads like the letter: lines that wrap are joined, so sentences stay whole; short lines (a heading,
//  "Dear Parents,", a list) stay on their own; a bigger gap starts a new paragraph. Nothing leaves the phone.
//
//  Registered in MainViewController.swift.
//

import Capacitor
import Foundation
import UIKit
import Vision

@objc(LetterTextPlugin)
public class LetterTextPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LetterTextPlugin"
    public let jsName = "LetterText"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
    ]

    @objc func read(_ call: CAPPluginCall) {
        guard let raw = call.getString("path"), !raw.isEmpty else {
            call.reject("No photo was given.")
            return
        }
        // A file path, a file:// URL, or the web view's form of one (capacitor://localhost/_capacitor_file_/…).
        let path = raw.components(separatedBy: "/_capacitor_file_").count > 1
            ? raw.components(separatedBy: "/_capacitor_file_").last ?? raw : raw
        let url: URL? = path.hasPrefix("file://") ? URL(string: path) : URL(fileURLWithPath: path)
        guard let url = url, let image = UIImage(contentsOfFile: url.path), let cg = image.cgImage else {
            call.reject("Couldn't open the photo.")
            return
        }
        let orientation = CGImagePropertyOrientation(image.imageOrientation)
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["en-GB", "en-US"]
            do {
                try VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:]).perform([request])
            } catch {
                call.reject("Couldn't read the photo.")
                return
            }
            let lines: [(String, CGRect)] = (request.results ?? []).compactMap { obs in
                guard let best = obs.topCandidates(1).first else { return nil }
                return (best.string, obs.boundingBox)
            }
            call.resolve(["text": Self.layout(lines), "lines": lines.count])
        }
    }

    /// Vision's boxes run from the bottom left (0...1). Rows top to bottom, words in a row left to right; a row
    /// that fills most of the width wraps into the next one, and a gap taller than a line starts a paragraph.
    static func layout(_ lines: [(String, CGRect)]) -> String {
        var rows: [[(String, CGRect)]] = []
        for line in lines.sorted(by: { $0.1.midY > $1.1.midY }) {
            if let first = rows.last?.first, abs(first.1.midY - line.1.midY) < min(first.1.height, line.1.height) / 2 {
                rows[rows.count - 1].append(line)
            } else {
                rows.append([line])
            }
        }
        let boxes = rows.map { row in row.dropFirst().reduce(row[0].1) { $0.union($1.1) } }
        let widest = boxes.map { $0.width }.max() ?? 1
        var out = ""
        for (i, row) in rows.enumerated() {
            let words = row.sorted(by: { $0.1.minX < $1.1.minX }).map { $0.0 }.joined(separator: " ")
            if i > 0 {
                let above = boxes[i - 1], box = boxes[i]
                if above.minY - box.maxY > 0.9 * max(above.height, box.height) {
                    out += "\n\n"
                } else if above.width > 0.7 * widest && !out.hasSuffix(":") && !out.hasSuffix(",") {
                    out += " "
                } else {
                    out += "\n"
                }
            }
            out += words
        }
        return out
    }
}

private extension CGImagePropertyOrientation {
    init(_ o: UIImage.Orientation) {
        switch o {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
