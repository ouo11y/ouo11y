# @ouo11y/kit

Frontend building blocks for a client's own ouo11y plugin or app ([ADR-0025](../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)): a replay player that plays a Muninn manifest, with chunks fetched by a function you supply. React and `rrweb-player` only: no Grafana dependency, and no backend of ours is assumed. Where the manifest and the chunks come from, and who may see them, is yours to decide.

```tsx
import { ReplayPlayer, type Manifest } from '@ouo11y/kit';

<ReplayPlayer
  manifest={manifest}                      // Muninn spec 7.2, e.g. from ouo-go's Muninn.Manifest
  fetchChunk={(stream, seq) =>             // decompressed bytes of one chunk, from your backend
    fetch(`/my-backend/replays/${manifest.replay_id}/streams/${stream}/chunks/${seq}`).then((r) => r.arrayBuffer())}
/>
```

Your bundler must handle the CSS import of `rrweb-player/dist/style.css` (webpack with `css-loader`, Vite as is).

The player picks a stream (a picker when there are several), keeps the runs that start at a keyframe and stop at a gap (Muninn spec RDR-3), concatenates each run's chunks before parsing them (a chunk may end mid-line), and chooses a renderer by `ouo.replay.format`:

| Format | Here |
|---|---|
| `rrweb/2` | Plays (`RrwebPlayer`) |
| `ouo-frames/3`, `ouo-video/1` | Shown as stored, not playable yet: the seam for the pixel players |
| `ouo-wireframe/1`, anything else | Stored, not playable (RPL-24) |

Key the player by replay id (`<ReplayPlayer key={replayId} …/>`) when one instance shows several replays, so its state starts fresh. The pieces are exported too: `playableRuns`, `primaryStream`, `parseNdjson`, `formatInfo`, and the manifest types.

Released with release-please as component `kit` (tag `kit-v<semver>`) and published by `release-npm.yml` ([releasing](../../docs/releasing.md)). `npm run build -w libs/ouo-kit` (tsup), `npm test -w libs/ouo-kit` (Vitest), `npm run typecheck -w libs/ouo-kit`. Licence Apache-2.0.
