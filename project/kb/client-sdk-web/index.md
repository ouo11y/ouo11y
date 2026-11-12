# Client SDK: web

How `@ouo11y/browser` is built after its rebuild on the client SDK spec (2026-11-12, [ADR-0020](../../../docs/adr/0020-web-sdk-rebuilt-on-the-spec.md)), what it emits, and what was learned on the way. Start with the compliance report.

| Path | What it is |
|---|---|
| [compliance/](compliance/index.md) | Every spec requirement that applies to the web, before and after, with the test that shows it |
| [architecture/](architecture/index.md) | How the SDK is put together on the OpenTelemetry JS SDK |
| [replay/](replay/index.md) | The replay format on the wire (`rrweb/2`), and the paused pixel recorder |
| [lessons/](lessons/index.md) | Quirks of the OpenTelemetry JS packages, browsers and the local toolchain that cost time |
