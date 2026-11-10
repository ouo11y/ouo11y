"""Reduces the overhead harness results to findings/overhead.json for build_report.py: medians and
ranges per variant, chart rows, and the proposed budgets from findings/budgets.json.

    python3 project/agents/sdk-state/scripts/summarize_overhead.py

Inputs (all under project/agents/sdk-state/):
  measure/web/results/bundle.json, runtime-1x.json, runtime-4x.json, rn-bundle.json, json-vs-proto.json
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


def mobile_rows(res, key, sub='median', scale=1.0, minus=None):
    out = []
    v = res.get('variants', {})
    for name, x in v.items():
        val = x.get(key)
        if isinstance(val, dict):
            val = val.get(sub)
        if val is None:
            continue
        if minus and minus in v:
            b = v[minus].get(key)
            b = b.get(sub) if isinstance(b, dict) else b
            if b is None or name == minus:
                continue
            val = val - b
        out.append({'label': name, 'sdk': sdk_of(name), 'value': max(val * scale, 0)})
    return out


def main():
    bundle = json.loads((WEB / 'bundle.json').read_text())
    rt1 = web_runtime(WEB / 'runtime-1x.json')
    rt4 = web_runtime(WEB / 'runtime-4x.json') if (WEB / 'runtime-4x.json').exists() else None
    rn = json.loads((WEB / 'rn-bundle.json').read_text())
    jp = json.loads((WEB / 'json-vs-proto.json').read_text())
    ios = json.loads((A / 'measure/ios/results.json').read_text())
    android = json.loads((A / 'measure/android/results.json').read_text())
    budgets = json.loads((A / 'findings/budgets.json').read_text())
    order = ['ouo-core', 'ouo-replay', 'sentry-errors', 'sentry-core', 'sentry-replay']
    kib = lambda b: b / 1024
    size_rows = lambda key, part: [{'label': LABEL[v], 'sdk': sdk_of(v), 'value': kib(bundle[v][part][key])} for v in order]
    v1 = rt1['variants']
    charts = [
        {'title': 'Web bundle', 'intro': 'Each variant bundled the way an app bundler would (esbuild, minified, ESM, code splitting). "Initial" is what the page downloads at load; ouo loads rrweb lazily, so its replay cost is a second chunk fetched only when replay is sampled. Sentry was bundled with its replay in the main chunk, its default.',
         'charts': [
             {'title': 'Initial download, gzip', 'unit': 'KiB', 'rows': size_rows('gzip', 'initial')},
             {'title': 'Initial download, brotli', 'unit': 'KiB', 'rows': size_rows('brotli', 'initial')},
             {'title': 'Everything incl. lazy replay chunk, gzip', 'unit': 'KiB', 'rows': size_rows('gzip', 'total')},
             {'title': 'React Native JS, gzip', 'unit': 'KiB', 'rows': [
                 {'label': 'ouo @ouo11y/react-native 0.3.0', 'sdk': 'ouo', 'value': rn['ouo']['gz_kib']},
                 {'label': 'Sentry @sentry/react-native 8.34.0', 'sdk': 'sentry', 'value': rn['sentry']['gz_kib']}],
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
    for name, res in (('iOS', ios), ('Android', android)):
        base = next((k for k in res.get('variants', {}) if sdk_of(k) == 'base'), None)
        cs = [
            {'title': f'{name}: app size added (zipped)', 'unit': 'KiB', 'rows': mobile_rows(res, 'size_zipped_bytes', scale=1 / 1024, minus=base), 'fmt': '{:.0f}'},
            {'title': f'{name}: init on the main thread', 'unit': 'ms', 'rows': mobile_rows(res, 'init_ms'), 'fmt': '{:.1f}'},
            {'title': f'{name}: CPU during the journey', 'unit': 'ms per minute', 'rows': mobile_rows(res, 'cpu_ms_per_min', sub=res.get('cpu_sub', 'journey')), 'fmt': '{:.0f}'},
            {'title': f'{name}: memory, peak', 'unit': 'MiB', 'rows': mobile_rows(res, 'mem_mb', sub='peak'), 'fmt': '{:.1f}'},
            {'title': f'{name}: bytes sent', 'unit': 'KiB per minute', 'rows': mobile_rows(res, 'wire_bytes_per_min', sub=res.get('wire_sub', 'median'), scale=1 / 1024), 'fmt': '{:.1f}'},
        ]
        charts.append({'title': f'{name} ({res.get("device", "")})', 'intro': res.get('method', ''), 'charts': [c for c in cs if c['rows']]})
    overhead = {
        'setup': budgets['setup'],
        'charts': charts,
        'budgets': budgets['budgets'],
        'not_measured': budgets['not_measured'] + ios.get('not_measured', []) + android.get('not_measured', []),
        'web': {'bundle': bundle, 'runtime_1x': rt1, 'runtime_4x': rt4, 'json_vs_proto': jp, 'rn_bundle': rn},
        'ios': ios, 'android': android,
    }
    (A / 'findings/overhead.json').write_text(json.dumps(overhead, indent=1))
    print('wrote findings/overhead.json')


if __name__ == '__main__':
    main()
