# Pagination in Sentry's read API

> How do Sentry cursors work, which endpoints use which kind, and how does Muninn page without losing rows?

Versions: Sentry self-hosted 26.10.0. Research date 2026-11-10. Docs: [Paginating Results](https://docs.sentry.io/api/pagination/) (accessed 2026-11-10).

## The `Link` header

Every paginated response carries one `Link` header with two entries (observed, [replays-list.headers.txt](fixtures/replays-list.headers.txt)):

```
link: <https://sentry.ouo.localhost/api/0/.../?per_page=2&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1",
      <https://sentry.ouo.localhost/api/0/.../?per_page=2&cursor=0:2:0>; rel="next"; results="true"; cursor="0:2:0"
```

- Cursor = `<value>:<offset>:<is_prev>`. Follow `rel="next"` only while `results="true"`. A `next` entry is always present, even on the last page.
- **The URL host is `system.url-prefix`, not the host you called.** Locally we called `http://localhost:9000` and got `https://sentry.ouo.localhost` links. Muninn should take the `cursor` value and rebuild the URL on its own base URL, not follow the link blindly.
- `X-Hits` / `X-Max-Hits` (issues only, observed `17` / `1000`) give a total estimate.

## Cursor kinds by endpoint (observed)

| Endpoint | Cursor kind | Example | Page size param, max |
|---|---|---|---|
| Replays list (R1) | offset (`ReplayPaginator`) | `0:2:0` | `per_page` ≤ 100 |
| Recording segments (R4) | offset (`GenericOffsetPaginator`) | `0:10:0` | `per_page` ≤ 100 |
| Issues list | score (last-seen ms for `sort=date`) | `1794280862000:0:0` | `limit` ≤ 100 |
| Issue events | offset | `0:5:0` | `per_page` ≤ 100 |
| Discover/Explore `/events/` | offset | `0:100:0` | `per_page` ≤ 100 (Snuba), ≤ 9999 (EAP: spans, logs) |
| `/sessions/` | offset over groups | `0:5000:0` | `per_page` |
| `/trace/{id}/` | none | | whole tree |

## Pitfalls

1. **Offset cursors drift.** New replays are sorted first under `-started_at`; if one arrives between page 1 and page 2, page 2 repeats the last row of page 1. If one disappears (deletion, retention), a row is skipped. Mitigation: page with a **fixed `end`** (not `statsPeriod`) and de-duplicate by id; or sort ascending by `started_at` inside a closed window.
2. Replays whose segment 0 has not arrived are dropped from a page after the limit was applied, so a page may hold fewer than `per_page` rows while `results="true"` (see [replays.md](replays.md)). Never stop paging because a page is short.
3. R4 pages contain no segment ids. Page index × `per_page` + position = the n-th existing segment, not necessarily segment id n.
4. Score cursors (issues) are stable under inserts but tie on equal scores; de-duplicate by id.

**Muninn can use it for:** a generic "follow cursors" helper (see `next_cursor` in [scripts/muninn_pull.py](scripts/muninn_pull.py)) that parses `Link`, keeps the cursor only, and stops on `results="false"`.
