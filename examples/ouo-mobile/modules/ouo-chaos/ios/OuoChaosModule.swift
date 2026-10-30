import ExpoModulesCore
import UIKit

/// Demo-only: makes the app hang or die the way the OS sees it, for the SDK's hang watchdog and
/// its next-launch termination check (mobile SDK spec C3). Not part of the SDK.
public class OuoChaosModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OuoChaos")

    /// Blocks the main thread for `ms` (no frame is drawn): a fully blocking hang.
    AsyncFunction("blockMainThread") { (ms: Double) in
      Thread.sleep(forTimeInterval: ms / 1000)
    }.runOnQueue(.main)

    /// Blocks the main thread `times` times for `ms`, with one frame drawn in between (the next
    /// block starts in a display link callback): a hang that is not fully blocking.
    Function("stutterMainThread") { (ms: Double, times: Int) in
      DispatchQueue.main.async { NextFrame.block(ms: ms, times: times) }
    }

    /// What jetsam does to an app over its memory limit: a memory warning, then SIGKILL (no crash
    /// report, no willTerminate). The kill waits a second so the warning's handlers ran.
    Function("simulateOutOfMemory") {
      DispatchQueue.main.async {
        NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: UIApplication.shared)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { kill(getpid(), SIGKILL) }
      }
    }
  }
}

/// Runs one block per frame: a one-shot display link calls back at the next frame after a block.
private final class NextFrame: NSObject {
  private let ms: Double
  private var left: Int

  private init(ms: Double, times: Int) {
    self.ms = ms
    self.left = times
  }

  static func block(ms: Double, times: Int) {
    NextFrame(ms: ms, times: times).run()
  }

  private func run() {
    guard left > 0 else { return }
    left -= 1
    Thread.sleep(forTimeInterval: ms / 1000)
    // The link retains its target (self) until it is invalidated.
    CADisplayLink(target: self, selector: #selector(tick(_:))).add(to: .main, forMode: .common)
  }

  @objc private func tick(_ link: CADisplayLink) {
    link.invalidate()
    run()
  }
}
