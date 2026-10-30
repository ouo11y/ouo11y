import Foundation
import Network

/// What an error report carries about the device when it happens (mobile SDK spec C2, error
/// context): the app's memory footprint, the memory still available to it, and the network type.
public enum ErrorContext {
    private static let lock = NSLock()
    private static var monitor: NWPathMonitor?
    private static var network = "unknown"

    /// Starts watching the network path (one `NWPathMonitor` on a utility queue). Idempotent.
    public static func start() {
        lock.lock()
        defer { lock.unlock() }
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { path in
            let type = connectionType(path)
            lock.withLock { network = type }
        }
        m.start(queue: DispatchQueue(label: "ouo.network-path", qos: .utility))
        monitor = m
    }

    /// `network.connection.type` (OTel semconv values): `wifi`, `cell`, `wired`, `unavailable`, `unknown`.
    public static var networkType: String { lock.withLock { network } }

    /// The app's physical memory footprint (what jetsam counts), bytes; nil when the kernel does not answer.
    public static var memoryFootprintBytes: UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? info.phys_footprint : nil
    }

    /// Memory the app can still allocate before the system terminates it, bytes (iOS); nil elsewhere.
    public static var memoryAvailableBytes: UInt64? {
        #if os(iOS) || os(tvOS) || os(visionOS)
        let v = os_proc_available_memory()
        return v > 0 ? UInt64(v) : nil
        #else
        return nil
        #endif
    }

    static func connectionType(_ path: NWPath) -> String {
        guard path.status == .satisfied else { return "unavailable" }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cell" }
        if path.usesInterfaceType(.wiredEthernet) { return "wired" }
        return "unknown"
    }
}
