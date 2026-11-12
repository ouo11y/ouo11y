// frames-ocr <in-dir> <png-out-dir>: every frame of every .mp4 (AVAssetImageGenerator, zero tolerance)
// and every .jpg in <in-dir> is written as PNG and read with Vision OCR (accurate). One JSON line per image.
import AVFoundation
import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
let inDir = URL(fileURLWithPath: args[1]), outDir = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func ocr(_ img: CGImage) -> [[String: Any]] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  req.minimumTextHeight = 0
  try? VNImageRequestHandler(cgImage: img).perform([req])
  return (req.results ?? []).compactMap { o in
    guard let c = o.topCandidates(1).first else { return nil }
    return ["text": c.string, "conf": Double(c.confidence)]
  }
}

func save(_ img: CGImage, _ name: String) {
  let rep = NSBitmapImageRep(cgImage: img)
  try? rep.representation(using: .png, properties: [:])?.write(to: outDir.appendingPathComponent(name))
}

func emit(_ d: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

let files = (try? FileManager.default.contentsOfDirectory(at: inDir, includingPropertiesForKeys: nil)) ?? []
for f in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
  if f.pathExtension == "mp4" {
    let asset = AVURLAsset(url: f)
    guard let track = asset.tracks(withMediaType: .video).first else { emit(["file": f.lastPathComponent, "error": "no track"]); continue }
    let reader = try! AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(out)
    reader.startReading()
    var times: [CMTime] = []
    while let sb = out.copyNextSampleBuffer() { if CMSampleBufferGetNumSamples(sb) > 0 { times.append(CMSampleBufferGetPresentationTimeStamp(sb)) } }
    let gen = AVAssetImageGenerator(asset: asset)
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    for (i, t) in times.enumerated() {
      guard let img = try? gen.copyCGImage(at: t, actualTime: nil) else { emit(["file": f.lastPathComponent, "frame": i, "error": "decode"]); continue }
      let name = "\(f.deletingPathExtension().lastPathComponent)-f\(i).png"
      save(img, name)
      emit(["file": f.lastPathComponent, "frame": i, "png": name, "w": img.width, "h": img.height, "text": ocr(img)])
    }
  } else if f.pathExtension == "jpg" {
    guard let src = CGImageSourceCreateWithURL(f as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
    emit(["file": f.lastPathComponent, "frame": 0, "png": f.lastPathComponent, "w": img.width, "h": img.height, "text": ocr(img)])
  }
}
