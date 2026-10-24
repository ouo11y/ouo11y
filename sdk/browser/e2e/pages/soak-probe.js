// Injected before any page script by the soak (page.addInitScript): counts what is alive in the
// page so growth shows in every engine, not only where a heap API exists. window.__probe()
// returns { listeners, observers, timers, intervals, nodes }.
//
// The wrappers report themselves as native code: rrweb treats a prototype whose methods are not
// native as tainted (Zone.js, other tools) and then takes clean prototypes from a hidden iframe,
// which on Safari changes what it does at every checkout. The instrument must not change that.
(() => {
  const nativeToString = Function.prototype.toString;
  const native = new WeakSet();
  const asNative = (fn, name) => (native.add(fn), Object.defineProperty(fn, "name", { value: name }), fn);
  Function.prototype.toString = asNative(function toString() {
    return native.has(this) ? `function ${this.name}() { [native code] }` : nativeToString.call(this);
  }, "toString");
  // Listeners on window and document only: those live as long as the page, so a count that grows
  // is a leak. Listeners on nodes, XHRs and channels go away with their target.
  const ids = new WeakMap();
  let next = 0;
  const id = (fn) => {
    if (!ids.has(fn)) ids.set(fn, ++next);
    return ids.get(fn);
  };
  const keyOf = (type, fn, o) => `${type}|${typeof o === "boolean" ? o : !!(o && o.capture)}|${id(fn)}`;
  const tracked = (t) => t === window || t === document;
  const keys = new Set();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = asNative(function (type, fn, opts) {
    // `once` listeners remove themselves when they fire; not counted.
    if (fn && tracked(this) && !(opts && typeof opts === "object" && opts.once)) keys.add(`${this === window ? "w" : "d"}|${keyOf(type, fn, opts)}`);
    return add.call(this, type, fn, opts);
  }, "addEventListener");
  EventTarget.prototype.removeEventListener = asNative(function (type, fn, opts) {
    if (fn && tracked(this)) keys.delete(`${this === window ? "w" : "d"}|${keyOf(type, fn, opts)}`);
    return remove.call(this, type, fn, opts);
  }, "removeEventListener");

  let observers = 0;
  for (const name of ["MutationObserver", "PerformanceObserver", "ResizeObserver", "IntersectionObserver"]) {
    const C = window[name];
    if (typeof C !== "function") continue;
    const active = new WeakSet();
    const observe = C.prototype.observe;
    const disconnect = C.prototype.disconnect;
    C.prototype.observe = asNative(function (...a) {
      if (!active.has(this)) {
        active.add(this);
        observers++;
      }
      return observe.apply(this, a);
    }, "observe");
    C.prototype.disconnect = asNative(function (...a) {
      if (active.delete(this)) observers--;
      return disconnect.apply(this, a);
    }, "disconnect");
  }

  const timers = new Set();
  const intervals = new Set();
  const st = window.setTimeout;
  const ct = window.clearTimeout;
  const si = window.setInterval;
  const ci = window.clearInterval;
  window.setTimeout = function (fn, ms, ...rest) {
    const h = st.call(
      window,
      (...a) => {
        timers.delete(h);
        if (typeof fn === "function") fn(...a);
      },
      ms,
      ...rest,
    );
    timers.add(h);
    return h;
  };
  window.clearTimeout = function (h) {
    timers.delete(h);
    return ct.call(window, h);
  };
  window.setInterval = function (...a) {
    const h = si.apply(window, a);
    intervals.add(h);
    return h;
  };
  window.clearInterval = function (h) {
    intervals.delete(h);
    return ci.call(window, h);
  };

  window.__probe = () => ({
    listeners: keys.size,
    observers,
    timers: timers.size,
    intervals: intervals.size,
    nodes: document.getElementsByTagName("*").length,
  });
})();
