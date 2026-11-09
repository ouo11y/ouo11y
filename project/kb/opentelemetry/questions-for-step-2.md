# Questions Step 1 hands to Step 2 (RUM semantic conventions)

Step 1 explains the data models. These are the decisions it leaves open. Background is in [signal-choice-and-backends.md](storage-backends/signal-choice-and-backends.md).

Existing conventions at semantic-conventions v1.45.0, all **Development**: `browser.web_vital` event; `session.id`, `session.previous_id`, `session.start` and `session.end` events; `app.screen.click`, `app.widget.click`, `app.crash`, `app.jank` events.

## Across everything

1. Which values are resource and which are record attributes? In particular, what is `service.instance.id` for a browser tab, if anything, given that Loki indexes it by default?
2. Where does `session.id` live? As a resource attribute it can only change with a new SDK resource; as a record attribute it is repeated on each record.
3. Do we follow Development conventions as written, or use `ouo.` names where they are not settled? What is the plan for when they change?
4. How do we keep `event_name` on Loki: a Collector copy into an attribute, or a backend change?
5. How do we handle device clock skew? Validate, correct, or both, and where (SDK or edge)?

## Web vitals

6. Event per vital (the `browser.web_vital` convention), metric, or both?
7. If server-side aggregation produces the percentiles, what is the single writer, and where does it run?
8. Which histogram for CLS, whose values the default buckets do not suit?
9. LCP, INP and CLS can change until page hide. Do we emit once at the end, or use `browser.web_vital.delta` with repeats?

## Errors

10. Log event with `exception.*` attributes (the current semconv direction), span status, or both?
11. Stack traces can reach Loki's 64 KB metadata limit as attributes. Do they go in the body, get truncated at source, or go in a reference?
12. How is grouping or fingerprinting carried?

## Clicks and interactions

13. Event, or span with a duration (for example, until the UI settles)?
14. Does a click start a trace, so its fetch calls join it? That also decides head sampling for those backend calls.
15. `app.screen.click` exists for mobile. Is there one model across web and mobile?

## Navigation and page loads

16. Is a page load a span with resource-timing children, or events?
17. What is a soft (SPA) navigation?
18. Where do trace boundaries sit? One trace per page load, per interaction, or per session with links?
19. What happens to a span still open at `pagehide`? End it with a marker attribute? Which attribute?

## Sessions

20. Are session start and end events enough, given that end is unreliable? Is a session end inferred from inactivity on the server?
21. Which fields does session health need, and can they be computed from events alone?
22. Does any sampling apply at session level, and how does it combine with trace sampling?

## Replays

23. Log record with an event name and bytes in the body, or a `*_ref` to object storage? Loki turns bytes into base64 strings and rejects bodies over 256 KB by default.
24. What are the size and flush rules, given the 64 KiB keepalive budget at page unload?
25. What fields tie a chunk to its session and to ordering (sequence number, time range)?
26. Do replay chunks use the same pipeline as other logs, or a separate one, so that they cannot crowd out errors?
