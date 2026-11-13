# @ouo11y/kit

Frontend building blocks for ouo11y ([ADR-0023](../../docs/adr/0023-plugin-bff-and-clearance.md)): the BFF's answer types and a replay player. React and `rrweb-player` only; no Grafana dependency, so it works in any React app that talks to an ouo BFF.

```tsx
import { ReplayPlayer, bffPaths } from '@ouo11y/kit';

<ReplayPlayer
  manifest={manifest}
  fetchChunk={(stream, seq) =>
    fetch(`${base}/${bffPaths.chunk(project, session, replay, stream, seq)}`).then((r) => r.arrayBuffer())}
/>
```

The player picks a stream (a picker when there are several), keeps the runs that start at a keyframe and stop at a gap (Muninn spec RDR-3), concatenates each run's chunks before parsing them (a chunk may end mid-line), and chooses a renderer by `ouo.replay.format`:

| Format | Here |
|---|---|
| `rrweb/2` | Plays (`RrwebPlayer`) |
| `ouo-frames/3`, `ouo-video/1` | Shown as stored, not playable: the seam for the pixel players, which still read the MVP wire in the plugin |
| `ouo-wireframe/1`, anything else | Stored, not playable (RPL-24) |

Private workspace package, imported from source by `plugins/ouo11y-rum-app`; not published until it has a second user. `npm test -w libs/ouo-kit` (Vitest), `npm run typecheck -w libs/ouo-kit`. Licence Apache-2.0.
