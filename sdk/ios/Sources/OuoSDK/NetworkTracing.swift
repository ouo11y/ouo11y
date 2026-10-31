import Foundation

/// C5 on top of `URLSessionHook`: one CLIENT span per request, `traceparent` and `baggage` for the
/// listed origins, `http.request.failed` for 5xx and network errors, `http.request` for the others
/// (the rules of the React Native SDK's fetch instrumentation).
extension Core {
    /// Said once per process, also without `debug`: C5 propagation stops if a future iOS drops
    /// `setCurrentRequest:`.
    static let headersUnavailable = OnceFlag()

    func taskWillResume(_ task: URLSessionTask) {
        guard task is URLSessionDataTask || task is URLSessionDownloadTask,
              let request = task.currentRequest ?? task.originalRequest, let url = request.url,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        let full = url.absoluteString
        guard !URLMatch.matches(full, ingestPrefixes), !URLMatch.matches(full, settings.ignoreUrls) else { return }
        activity()
        let method = (request.httpMethod ?? "GET").uppercased()
        var attrs: Attributes = ["http.request.method": .string(method), "url.full": .string(full), "url.scheme": .string(scheme), "url.path": .string(url.path.isEmpty ? "/" : url.path)]
        if let host = url.host { attrs["server.address"] = .string(host) }
        attrs["server.port"] = .int(Int64(url.port ?? (scheme == "https" ? 443 : 80)))
        let span = OuoSpan(core: self, name: "HTTP \(method)", kind: .client, attributes: attrs, parent: OuoSpan.active, start: now())
        if URLMatch.matches(full, settings.propagateTo) {
            var r = request
            if r.value(forHTTPHeaderField: "traceparent") == nil {
                r.setValue(Propagation.traceparent(traceId: span.traceId, spanId: span.spanId), forHTTPHeaderField: "traceparent")
            }
            let ids = correlation()
            r.setValue(Propagation.baggage(existing: r.value(forHTTPHeaderField: "baggage"), [
                ("session.id", ids["session.id"]?.text ?? ""), ("user.id", ids["user.id"]?.text ?? ""), ("ouo.platform", Core.platform),
            ]), forHTTPHeaderField: "baggage")
            if !URLSessionHook.setRequest(r, on: task) { Core.headersUnavailable.once { NSLog("[ouo] this iOS version's URLSessionTask cannot take trace headers: requests are traced, but traceparent and baggage are not sent") } }
        }
        URLSessionHook.onCompletion(task) { [weak self] t in self?.taskCompleted(t, span: span, method: method, url: full) }
    }

    func taskCompleted(_ task: URLSessionTask, span: OuoSpan, method: String, url: String) {
        let body = "\(method) \(url)"
        let trace = (span.traceId, span.spanId)
        if let e = task.error as NSError? {
            span.setError(e.localizedDescription)
            // Cancelled by the app: not a failure of the network or the server.
            if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled {
                span.end()
                return
            }
            let type = "\(e.domain) \(e.code)"
            span.set("error.type", .string(type))
            span.set("ouo.http.failed", true)
            event("http.request.failed", ["http.request.method": .string(method), "url.full": .string(url), "http.response.status_code": 0, "error.type": .string(type)],
                  severity: .error, body: body, trace: trace)
        } else {
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            let a: Attributes = ["http.request.method": .string(method), "url.full": .string(url), "http.response.status_code": .int(Int64(status))]
            span.set("http.response.status_code", .int(Int64(status)))
            if status == 0 || (500...599).contains(status) {
                span.setError("HTTP \(status)")
                span.set("ouo.http.failed", true)
                event("http.request.failed", a, severity: .error, body: body, trace: trace)
            } else if settings.requestEvents {
                event("http.request", a, body: body, trace: trace)
            }
        }
        span.end()
    }
}

final class OnceFlag {
    private let lock = NSLock()
    private var done = false
    func once(_ body: () -> Void) {
        let first = lock.withLock { () -> Bool in defer { done = true }; return !done }
        if first { body() }
    }
}
