"""Reduces the overhead harness results to findings/overhead.json for build_report.py: medians and
ranges per variant, chart rows, and the proposed budgets from findings/budgets.json.

    python3 project/agents/sdk-state/scripts/summarize_overhead.py

Inputs (all under project/agents/sdk-state/):
  measure/web/results/bundle.json, runtime-1x.json, runtime-4x.json, json-vs-proto.json
  measure/react-native/results/rn-bundle.json
  measure/ios/results.json, measure/android/results.json
  findings/budgets.json
"""
import json, pathlib, statistics

ROOT = pathlib.Path(__file__).resolve().parents[4]
A = ROOT / 'project/agents/sdk-state'
WEB = A / 'measure/web/results'
LABEL = {'none': 'No SDK', 'ouo-core': 'ouo core', 'ouo-replay': 'ouo + replay', 'sentry-errors': 'Sentry errors only',
         'sentry-core': 'Sentry + tracing', 'sentry-replay': 'Sentry + tracing + replay'}


def sdk_of(v):
    return 'ouo' if v.startswith('ouo') else 'sentry' if v.startswith('sentry') else 'base'


def stat(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return {'median': statistics.median(xs), 'lo': min(xs), 'hi': max(xs), 'n': len(xs)}


def web_runtime(path):
    d = json.loads(path.read_text())
    by = {}
    for r in d['results']:
        by.setdefault(r['variant'], []).append(r)
    out = {}
    for v, rs in by.items():
        per_min = lambda key: [x[key] * 60000 / x['journeyMs'] for x in rs]
        out[v] = {
            'runs': len(rs), 'load1': stat([x.get('loadavg1') for x in rs]),
            'init_ms': stat([x['initMs'] for x in rs]),
            'startup_task_ms': stat([x['startupTaskMs'] for x in rs]),
            'task_ms_per_min': stat(per_min('journeyTaskMs')),
            'renderer_cpu_ms_per_min': stat(per_min('journeyRendererCpuMs')),
            'heap_mb': stat([x['heapUsedMB'] for x in rs]),
            'ix_task_p50_ms': stat([x['ixTaskP50'] for x in rs]),
            'ix_task_p90_ms': stat([x['ixTaskP90'] for x in rs]),
            'ix_task_max_ms': stat([x['ixTaskMax'] for x in rs]),
            'total_blocking_ms': stat([x['longTasks']['totalBlockingMs'] for x in rs]),
            'wire_kib_per_min': stat([b / 1024 for b in per_min('ingestBytes')]),
            'replay_kib_per_min': stat([b / 1024 for b in per_min('replayBytes')]),
            'telemetry_kib_per_min': stat([(x['ingestBytes'] - x['replayBytes']) / 1024 * 60000 / x['journeyMs'] for x in rs]),
            'requests_per_min': stat(per_min('requests')),
        }
    return {'chromium': d['chromium'], 'throttle': d['cpuThrottle'], 'journey_ms': d['journeyMs'], 'variants': out}


def delta(var, base, key):
    if key not in var or not var[key] or not base.get(key):
        return None
    b = base[key]['median']
    return {k: (var[key][k] - b if k in ('median', 'lo', 'hi') else var[key][k]) for k in var[key]}


def rows(variants, key, minus=None, order=None):
    out = []
    for v in order or variants:
        if v not in variants:
            continue
        s = delta(variants[v], variants[minus], key) if minus else variants[v].get(key)
        if s is None:
            continue
        out.append({'label': LABEL.get(v, v), 'sdk': sdk_of(v), 'value': max(s['median'], 0), 'lo': max(s['lo'], 0), 'hi': max(s['hi'], 0)})
    return out


MLABEL = {'ouo': 'ouo core', 'ouo_replay': 'ouo + replay', 'sentry': 'Sentry + tracing', 'sentry_replay': 'Sentry + tracing + replay',
          'ouosignals': 'ouo signals only', 'ouofull': 'ouo signals + replay', 'sentrycore': 'Sentry + tracing', 'sentryreplay': 'Sentry + tracing + replay',
          'sentryfull': 'Sentry + NDK (size only)'}


def get(x, path):
    """The value at a dotted path: a stats dict ({median, min, max, ...}) or a plain number."""
    for k in path.split('.'):
        if not isinstance(x, dict) or k not in x:
            return None
        x = x[k]
    return x


def mobile_rows(res, path, scale=1.0, minus_base=False):
    """Chart rows for every SDK variant (the no-SDK base is the reference, not a bar). Stats give
    whiskers from the lowest to the highest run, minus the base median like the bar itself."""
    v = res.get('variants', {})
    base = next((k for k in v if sdk_of(k) == 'base'), None)
    b = 0
    if minus_base:
        bs = get(v[base], path)
        b = bs['median'] if isinstance(bs, dict) else bs
    out = []
    for name, x in v.items():
        s = get(x, path)
        if name == base or s is None:
            continue
        row = {'label': MLABEL.get(name, name), 'sdk': sdk_of(name)}
        if isinstance(s, dict):
            row.update(value=max((s['median'] - b) * scale, 0), lo=max((s['min'] - b) * scale, 0), hi=max((s['max'] - b) * scale, 0))
        else:
            row['value'] = max((s - b) * scale, 0)
        out.append(row)
    return out


def main():
    bundle = json.loads((WEB / 'bundle.json').read_text())
    rt1 = web_runtime(WEB / 'runtime-1x.json')
    rt4 = web_runtime(WEB / 'runtime-4x.json') if (WEB / 'runtime-4x.json').exists() else None
    rn = json.loads((A / 'measure/react-native/results/rn-bundle.json').read_text())
    jp = json.loads((WEB / 'json-vs-proto.json').read_text())
    ios = json.loads((A / 'measure/ios/results.json').read_text())
    android = json.loads((A / 'measure/android/results.json').read_text())
    budgets = json.loads((A / 'findings/budgets.json').read_text())
    order = ['ouo-core', 'ouo-replay', 'sentry-errors', 'sentry-core', 'sentry-replay']
    kib = lambda b: b / 1024
    size_rows = lambda key, part, vs=order: [{'label': LABEL[v], 'sdk': sdk_of(v), 'value': kib(bundle[v][part][key])} for v in vs]
    v1 = rt1['variants']
    charts = [
        {'title': 'Web bundle', 'intro': 'Each variant bundled the way an app bundler would (esbuild, minified, ESM, code splitting). "Initial" is what the page downloads at load; ouo loads rrweb lazily, so its replay cost is a second chunk fetched only when replay is sampled. Sentry was bundled with its replay in the main chunk, its default.',
         'charts': [
             {'title': 'Initial download, gzip', 'unit': 'KiB', 'rows': size_rows('gzip', 'initial')},
             {'title': 'Initial download, brotli', 'unit': 'KiB', 'rows': size_rows('brotli', 'initial')},
             {'title': 'With replay sampled: all JS downloaded, gzip', 'unit': 'KiB', 'rows': size_rows('gzip', 'total', ['ouo-replay', 'sentry-replay']), 'note': 'ouo: the initial chunk plus the lazy rrweb chunk. A session without replay downloads only the initial chunk.'},
             {'title': 'React Native JS, gzip', 'unit': 'KiB', 'rows': [
                 {'label': 'ouo 0.3.0', 'sdk': 'ouo', 'value': rn['ouo']['gz_kib']},
                 {'label': 'Sentry 8.34.0', 'sdk': 'sentry', 'value': rn['sentry']['gz_kib']}],
              'note': 'JS only, React Native and Expo packages external. Native code is extra (see the iOS and Android charts).'},
         ]},
        {'title': 'Web runtime, 60 s journey, headless Chromium', 'intro': f"Chromium {rt1['chromium']}, no CPU throttling, {v1['ouo-core']['runs']} interleaved rounds per variant. Values are the SDK's added cost: the variant's median minus the no-SDK median. Whiskers are the lowest and highest run, also minus the no-SDK median.",
         'charts': [
             {'title': 'Init call on the main thread', 'unit': 'ms', 'rows': rows(v1, 'init_ms', order=order), 'fmt': '{:.1f}', 'note': 'Synchronous time of the init call itself; work it schedules later is in the CPU charts.'},
             {'title': 'Main-thread task time added', 'unit': 'ms per minute', 'rows': rows(v1, 'task_ms_per_min', 'none', order), 'fmt': '{:.0f}'},
             {'title': 'Renderer CPU added (main thread and workers)', 'unit': 'ms per minute', 'rows': rows(v1, 'renderer_cpu_ms_per_min', 'none', order), 'fmt': '{:.0f}'},
             {'title': 'JS heap added after GC', 'unit': 'MiB', 'rows': rows(v1, 'heap_mb', 'none', order), 'fmt': '{:.1f}'},
             {'title': 'Interaction task, p90, added', 'unit': 'ms', 'rows': rows(v1, 'ix_task_p90_ms', 'none', order), 'fmt': '{:.2f}', 'note': 'The main-thread task that dispatched each click, key or wheel event: app handler plus SDK listeners and observers.'},
             {'title': 'Bytes sent, all ingest', 'unit': 'KiB per minute', 'rows': rows(v1, 'wire_kib_per_min', order=order), 'fmt': '{:.1f}', 'note': 'Request bodies as received by the fake collector (compressed where the SDK compresses), including the flush at page close.'},
             {'title': 'Of which replay', 'unit': 'KiB per minute', 'rows': rows(v1, 'replay_kib_per_min', order=['ouo-replay', 'sentry-replay']), 'fmt': '{:.1f}'},
         ]},
    ]
    if rt4:
        v4 = rt4['variants']
        charts.append({'title': 'Web runtime with 4x CPU throttling', 'intro': f"The same journey with Chrome's CPU throttled 4x, a rough stand-in for a mid-range phone; {v4['ouo-core']['runs']} rounds.",
                       'charts': [
                           {'title': 'Init call on the main thread (4x)', 'unit': 'ms', 'rows': rows(v4, 'init_ms', order=order)},
                           {'title': 'Main-thread task time added (4x)', 'unit': 'ms per minute', 'rows': rows(v4, 'task_ms_per_min', 'none', order), 'fmt': '{:.0f}'},
                           {'title': 'Interaction task, p90, added (4x)', 'unit': 'ms', 'rows': rows(v4, 'ix_task_p90_ms', 'none', order), 'fmt': '{:.2f}'},
                       ]})
    charts.append({'title': 'iOS Simulator', 'intro': f"iPhone 17 Pro simulator, iOS 27.0: simulator numbers, not device numbers. One UIKit app built three ways (no SDK, ouo11y-ios 0.3.0, sentry-cocoa 9.33.0); replay is a runtime switch. Size is the arm64 device build. Init: 12 cold launches, about half of them at host load 10 to 139 (the medians of the quiet launches match). CPU, memory and bytes: 3 interleaved rounds of 20 s idle plus a 60 s timer-driven journey at host load about 2 to 3. Values are added over the no-SDK app; whiskers are the lowest and highest run, minus the no-SDK median. At n = 3, read only differences whose ranges do not overlap. Details: measure/ios/README.md.",
                   'charts': [
                       {'title': 'iOS: app size added, zipped', 'unit': 'KiB', 'rows': mobile_rows(ios, 'size_zipped_delta_bytes', 1 / 1024), 'fmt': '{:.0f}'},
                       {'title': 'iOS: init on the main thread', 'unit': 'ms', 'rows': mobile_rows(ios, 'init_ms'), 'fmt': '{:.1f}'},
                       {'title': 'iOS: CPU added, idle screen', 'unit': 'ms per minute', 'rows': mobile_rows(ios, 'cpu_ms_per_min.idle', minus_base=True), 'fmt': '{:.0f}'},
                       {'title': 'iOS: CPU added, journey', 'unit': 'ms per minute', 'rows': mobile_rows(ios, 'cpu_ms_per_min.journey', minus_base=True), 'fmt': '{:.0f}'},
                       {'title': 'iOS: peak memory added', 'unit': 'MiB', 'rows': mobile_rows(ios, 'mem_mb.peak', minus_base=True), 'fmt': '{:.1f}'},
                       {'title': 'iOS: bytes sent', 'unit': 'KiB per minute', 'rows': mobile_rows(ios, 'wire_bytes_per_min.body_as_sent', 1 / 1024), 'fmt': '{:.1f}'},
                   ]})
    charts.append({'title': 'Android emulator', 'intro': f"Android emulator, API 35, arm64, 4 vCPU, software graphics. One native Kotlin app built per variant with R8. ouo here is the Kotlin code the React Native SDK vendors (signals and replay): it has no native exporter, so it sends replay only, while Sentry also sends errors, spans and sessions. CPU counts every thread but the render thread, because emulated graphics swamp total CPU. 3 interleaved rounds; whiskers are the lowest and highest run, minus the no-SDK median. Details: measure/android/README.md.",
                   'charts': [
                       {'title': 'Android: APK size added', 'unit': 'KiB', 'rows': mobile_rows(android, 'size_zipped_bytes', 1 / 1024), 'fmt': '{:.0f}'},
                       {'title': 'Android: init on the main thread', 'unit': 'ms', 'rows': mobile_rows(android, 'init_ms'), 'fmt': '{:.1f}'},
                       {'title': 'Android: CPU added off the render thread, journey', 'unit': 'ms per minute', 'rows': mobile_rows(android, 'journey_cpu_ms_per_min_off_render', minus_base=True), 'fmt': '{:.0f}',
                        'note': 'Every thread but RenderThread: the SDK threads plus the main, binder, JIT and GC work they cause.'},
                       {'title': 'Android: steady memory added (PSS after settle)', 'unit': 'MiB', 'rows': mobile_rows(android, 'mem_mb.idle_spread', minus_base=True), 'fmt': '{:.1f}', 'note': 'Peak PSS (five samples in the journey) moved by about 1 MiB between runs, more than the SDKs added, so the steady value is shown.'},
                       {'title': 'Android: bytes sent', 'unit': 'KiB per minute', 'rows': mobile_rows(android, 'wire_body_bytes_per_min', 1 / 1024), 'fmt': '{:.1f}'},
                   ]})
    overhead = {
        'setup': budgets['setup'],
        'charts': charts,
        'budgets': budgets['budgets'],
        'not_measured': budgets['not_measured'] + ios.get('not_measured', []) + android.get('not_measured', []),
        'web': {'runtime_1x': rt1, 'runtime_4x': rt4},
    }
    (A / 'findings/overhead.json').write_text(json.dumps(overhead, indent=1))
    print('wrote findings/overhead.json')


if __name__ == '__main__':
    main()
