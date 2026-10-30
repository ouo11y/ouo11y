import OuoSDK
import SimKit
import SwiftUI

/// A SwiftUI `App`: `Ouo.start` in `init`, the first screen from `onAppear`.
@main
struct SimApp: App {
    init() { startOuo(variant: "swiftui") }

    var body: some Scene {
        WindowGroup {
            Text("ouo W8").onAppear { Ouo.trackScreen("Home") }
        }
    }
}
