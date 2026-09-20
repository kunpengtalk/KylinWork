// macOS Vision 快速验证码识别：单一用途，读图形验证码里的英数短码
import Vision
import AppKit
import Foundation

let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("无法读取图片\n".data(using: .utf8)!)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
request.minimumTextHeight = 0.0
// 干扰线少的验证码 fast 足够；多候选提高命中
request.customWords = [] as [String]

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
    let candidates = (request.results ?? []).compactMap { obs -> String? in
        obs.topCandidates(5).first?.string
    }
    let joined = candidates.joined(separator: "")
    // 过滤成常见的验证码字符集（大写字母+数字），去空格
    let filtered = joined.filter { $0.isNumber || ($0.isLetter && $0.isASCII) }.uppercased()
    print(filtered)
    // 也输出未过滤的原始识别结果便于人工比对
    FileHandle.standardError.write(("RAW:" + joined + "\n").data(using: .utf8)!)
} catch {
    FileHandle.standardError.write("OCR 失败: \(error)\n".data(using: .utf8)!)
    exit(4)
}
