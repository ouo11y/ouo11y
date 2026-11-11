# Browser Session Replay segment format (v7 "Change" encoding)

- **SDK:** `@datadog/browser-rum` 7.17.0.
- **Schemas:** `rum-events-format` at `a4358681`.
- **Shorthands:**
  - `src:` = `https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/browser-rum/src/`
  - `schema:` = `https://github.com/DataDog/rum-events-format/blob/a435868176db82fc337d7b6771e16b758e188509/schemas/session-replay/`
- Research date 2026-11-10.
- Observed fixtures: [replay-segment-first.json](fixtures/browser/replay-segment-first.json), [replay-segment-next.json](fixtures/browser/replay-segment-next.json).
- Decoder: [decode-change-snapshot.mjs](../../../../../examples/datadog-capture/decode-change-snapshot.mjs).

**Main finding:** Datadog's docs still say replay "uses rrweb". The v7 SDK does **not** send rrweb snapshots anymore.
- Full snapshots and DOM mutations use a compact, string-table-based "Change" encoding: record type **12**, plus full snapshots with `format: 1`.
- Only mouse, scroll, touch, viewport, media and stylesheet-rule events still use rrweb-style incremental records.
- The schema marks the Change record "Experimental; subject to change", but 7.17.0 emits it **by default**. No flag is involved (`src:domain/record/serialization/serializationTransaction.ts#L229-L243`).

## Request framing

One HTTP request per segment, `POST /api/v2/replay?ddsource=browser&dd-api-key=…&dd-evp-origin=browser&dd-evp-origin-version=7.17.0&dd-request-id=…`, `multipart/form-data` (`src:domain/segmentCollection/buildReplayPayload.ts`):

| Part | Filename | Type | Content |
|---|---|---|---|
| `segment` | `<session.id>-<segment start ms>` | `application/octet-stream` | zlib deflate of `{"records":[…],<metadata>}\n` |
| `event` | `blob` | `application/json` | Metadata plus `raw_segment_size` and `compressed_segment_size` |

**Segment lifecycle** (`src:domain/segmentCollection/segmentCollection.ts`):
- A segment is flushed after 5 s (`SEGMENT_DURATION_LIMIT`), or at 60 000 compressed bytes (`SEGMENT_BYTES_LIMIT`).
- It is also flushed on a new view, on page exit, and on `stop`.
- `creation_reason` is one of `init`, `segment_duration_limit`, `segment_bytes_limit`, `view_change`, `before_unload`, `visibility_hidden`, `page_frozen` (`schema:browser/creation-reason-schema.json`).
- `index_in_view` counts segments per view. Index 0 must hold a full snapshot (`has_full_snapshot`).
- The JSON is streamed record by record into the deflate worker: `{"records":[` then `,record`…, then the metadata tail (`src:domain/segmentCollection/segment.ts`).

## Record types

From `src:types/sessionReplayConstants.ts` and `schema:browser/record-schema.json`:

| `type` | Name | Notes | Observed in run1 |
|---|---|---|---|
| 2 | FullSnapshot | `format: 1` (Change): `data` is a **list of changes**. Format 0 / v1 is the older rrweb-like node tree (`full-snapshot-v1-record-schema.json`). | Segment 1 and the first segment of view 2 |
| 3 | IncrementalSnapshot | `data.source`: 1 MouseMove, 2 MouseInteraction, 3 Scroll, 4 ViewportResize, 6 TouchMove, 7 MediaInteraction, 8 StyleSheetRule. Sources 0 (Mutation) and 5 (Input) are not emitted by v7; they became Change records. | 30 / 77 per segment, mostly mouse |
| 4 | Meta | `{href, width, height}` | yes |
| 6 | Focus | `{has_focus}` | yes |
| 7 | ViewEnd | — | yes |
| 8 | VisualViewport | Pinch-zoom viewport | yes |
| 9 | FrustrationRecord | Links a replay moment to frustration action ids | — |
| 12 | Change | `data`: list of changes (mutations, text, input values, scroll, size) | 2–7 per segment |

## Change encoding

Each change is an array `[changeType, ...items]` (`schema:browser/changes/change-schema.json`):

| Id | Change | Item shape |
|---|---|---|
| 0 | AddString | strings appended to the string table |
| 1 | AddNode | `[insertionPoint, nodeName, ...]`. Elements are followed by `[attrName, attrValue]` pairs; text nodes by their content; doctype by name, publicId, systemId. |
| 2 | RemoveNode | node ids |
| 3 | Attribute | `[nodeId, [name, value \| null]…]` |
| 4 | Text | `[nodeId, text]` |
| 5 | Size | `[nodeId, width, height]` |
| 6 | ScrollPosition | `[nodeId, x, y]` |
| 7 | AddStyleSheet | stylesheet rules (string refs) |
| 8 | AttachedStyleSheets | `[nodeId, sheetIds…]` |
| 9 | MediaPlaybackState | `[nodeId, state]` |
| 10 | VisualViewport | viewport values |
| 11 | AddRoleAnnotatedStrings | `[role, strings…]` groups |
| 12 | InputValue | `[nodeId, value]` |
| 13 | InputSelection | selection range |
| 14 | ClearStrings | empties the string table |
| 15 | ImageContent | `[nodeId, resourceId]`. Image bytes are uploaded separately as `image` parts. |

**Strings:**
- Wherever a string is expected, a number is an **index into the string table**. The table is built up by changes 0 and 11 in the order they arrive.
- String roles (`schema:browser/changes/string-references/string-role-schema.json`): 0 default, 1 node name, 2 attribute name, 3 attribute value, 4 text content, 5 form input, 6 CSS, 7 URL, 8 resource id.
- Roles let the backend apply privacy or dedup per kind of string. Masked inputs become the single string `"***"` in role 5 (observed).

**Node ids are implicit:** each added node gets the next id, starting at 0 for `#document`. The insertion point is relative:

| Insertion point | Meaning |
|---|---|
| `null` | root |
| `N > 0` | append to the node with id *(new id − N)* |
| `0` | insert after the previous node (new id − 1) |
| `-N` | insert before the node with id *(new id − N)* |

Decoded start of the observed full snapshot (`node decode-change-snapshot.mjs …/replay-segment-first.json`):

```
#0 root           "#document"
#1 append to #0   "#doctype" "html" "" ""
#2 after #1       "HTML" "lang"="en"
#3 append to #2   "HEAD"
#5 after #4       "META" "charset"="utf-8"
#21 after #20     "H1" "id"="title"
#22 append to #21 "#text" "Datadog capture demo"
#38 after #37     "BUTTON" "id"="btn-action" "data-dd-action-name"="named click"
```

- The whole first snapshot of our page had a 102-entry string table.
- Its changes were `11` (strings), `1` (all nodes), `5` (sizes), `6` (scroll), `7` (the inlined CSS of the `<style>` element) and `8` (stylesheet attached to node 12).
- Raw segment: 7 272 B. Wire: 2 498 B.

**A later DOM mutation** (observed, the page's log `<div>` changing text): `[[11,[4,"…new text…"]],[1,[5,4,105]],[2,127]]`. That is: add the new text string, add a node whose parent is 5 ids up, with name string 4 (`#text`) and content string 105, then remove the old text node 127.

**Typing into inputs** (observed): `[12,[97,110]]` and `[12,[101,110]]`. Both inputs got string 110, which is `"***"`, because of `mask-user-input`. No keystroke-level records were sent.

## How this differs from rrweb

| Aspect | rrweb (and older Datadog) | Datadog v7 Change format |
|---|---|---|
| Full snapshot | Nested JSON node tree with `id` on every node | Flat list of AddNode tuples; ids implicit; relative insertion points |
| Strings | Repeated inline | Deduplicated string table, with roles |
| Mutations | `IncrementalSnapshot` source 0 `{adds, removes, texts, attributes}` | `Change` record (type 12) |
| Input | Source 5 `{text, isChecked}` | `InputValue` change with a string ref |
| Sizes and scroll of elements | Not in rrweb's snapshot | `Size` / `ScrollPosition` changes |
| Mouse, touch, scroll events | Source 1/2/3/6 | Unchanged (rrweb-compatible numbering) |
| Images | Inline or URL | `ImageContent` with a resource id; bytes uploaded once, deduplicated by hash |
| Record types | 0–6 (+ plugin) | Adds 7 ViewEnd, 8 VisualViewport, 9 Frustration, 12 Change; drops rrweb `Custom` / `Plugin` |
| Segmenting | None (an event stream) | Per view, 5 s / 60 KB, with metadata; each view starts with Meta + Focus + FullSnapshot |

**Implications:**
- The **rrweb player cannot play Datadog v7 browser segments** without a converter. A converter would replay the change list into rrweb's node tree, which is mechanical.
- Datadog's public "get segments" API returns segments in an undocumented format ([read-apis.md](../apis/read-apis.md)). Expect this Change format.
- For our own SDK (rrweb-based replay in the MVP), this is a size optimisation to watch. String tables and implicit ids cut the full snapshot well below rrweb's JSON. In our run the raw first segment was 7.3 KB for a 120-node page.
