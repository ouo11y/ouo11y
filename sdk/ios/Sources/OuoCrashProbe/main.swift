// Test helper for OuoCrashTests: installs ouo's crash handlers in a fresh process, then crashes.
//
//   OuoCrashProbe <report dir> <session id> <segv|abort|nsexception|trap|none> [chain-marker-file]
//
// With a marker file, a "previous" signal handler and NSException handler are installed first
// (standing in for Sentry): each appends a line to the file, so the test can check ouo chained to
// them instead of swallowing the crash.
import Foundation
import OuoCrash

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write("usage: OuoCrashProbe <dir> <session> <kind> [marker]\n".data(using: .utf8)!)
    exit(2)
}
let dir = URL(fileURLWithPath: args[1])
let kind = args[3]

nonisolated(unsafe) var markerFD: Int32 = -1
if args.count >= 5 {
    markerFD = open(args[4], O_WRONLY | O_CREAT | O_APPEND, 0o644)
    var sa = sigaction()
    sa.__sigaction_u.__sa_sigaction = { sig, _, _ in
        let line = "previous signal handler \(sig)\n"
        _ = line.withCString { write(markerFD, $0, strlen($0)) }
        signal(sig, SIG_DFL)
        raise(sig)
    }
    sa.sa_flags = SA_SIGINFO
    for s in [SIGSEGV, SIGBUS, SIGABRT, SIGTRAP, SIGILL] { sigaction(s, &sa, nil) }
    NSSetUncaughtExceptionHandler { e in
        let line = "previous exception handler \(e.name.rawValue)\n"
        _ = line.withCString { write(markerFD, $0, strlen($0)) }
    }
}

OuoCrash.install(directory: dir)
OuoCrash.setSessionId(args[2])

@inline(never) func crashSegv() {
    let p = UnsafeMutablePointer<Int>(bitPattern: 0x10)!
    p.pointee = 42
}

@inline(never) func level2(_ kind: String) {
    switch kind {
    case "segv": crashSegv()
    case "abort": abort()
    case "trap": fatalError("probe trap")
    case "nsexception":
        NSException(name: NSExceptionName("OuoProbeException"), reason: "probe reason \"quoted\"", userInfo: nil).raise()
    default: break
    }
}

@inline(never) func level1(_ kind: String) { level2(kind) }

level1(kind)
print("no crash")
exit(0)
