import ExpoModulesCore

// One function, `crash()`: a write through a bad pointer, the classic native crash
// (EXC_BAD_ACCESS, SIGSEGV). ouo's signal handler writes a report; the next launch sends it.
public class TinyCrashModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TinyCrash")

    Function("crash") {
      let pointer = UnsafeMutablePointer<Int>(bitPattern: 0x8)!
      pointer.pointee = 42
    }
  }
}
