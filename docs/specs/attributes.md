# User and session attributes, OTA bundle identity

Normative for the browser SDK (`@ouo11y/browser`), the React Native SDK (`@ouo11y/react-native`),
the native iOS SDK (`sdk/ios`), rum-api and the plugin. Gaps F1 and F2 (2026-11-04); web roadmap
item WB7.

## 1. What they are

An app tags its users and sessions with a few low-cardinality facts it owns: the tenant, the plan,
a feature cohort, an A/B arm. The SDK stamps them on every later span and log record; rum-api keeps
them on the session record and filters sessions by them; the plugin shows them on the session page.

They are **app-controlled and may contain personal data**: the SDK sends what the app passes. Do
not put names, e-mail addresses, phone numbers or free text in them. They are covered by the same
retention and delete-by-user rules as every other signal of the session.

## 2. API

| Call | Scope | Effect |
|---|---|---|
| `setUser({ id, attributes? })` | user | Identifies the user (session-lifecycle rules unchanged). `attributes`, when given, **replaces** the user's attribute set; omitted, the set is kept for the same user and emptied for a different one. |
| `clearUser()` | user | Logout: the user's attribute set is emptied with the user. |
| `setAttributes(map)` | app | Merges `map` into the app's attribute set. A later value of a key replaces the earlier one. |
| `removeAttribute(key)` | both | Removes `key` from both sets. |

iOS: `Ouo.setUser(_ id: String, attributes: [String: Any]? = nil)`, `Ouo.setAttributes(_:)`,
`Ouo.removeAttribute(_:)`.

- The user set belongs to the user: it is persisted with `user.id` (browser `ouo.user`, RN and iOS
  the same store as the user id) and swapped at the same moment as the user, so in a `user_change`
  rotation the `session.end` of the old session carries the old user's set and the new session's
  `session.start` the new one's.
- The app set lives for the process (page load, app launch). It is not persisted: set it at start,
  like the service version.
- On a key in both sets the app set wins.
- Every public call is contained: it never throws into the app. Rejected keys and values are
  dropped and reported to the debug log (`debug: true`).
- Browser and RN, before consent (ADR-0018): the calls are queued with the others and replayed at
  grant.

## 3. Validation

| Rule | Value |
|---|---|
| Key | `^[A-Za-z][A-Za-z0-9_]{0,39}$`: a letter, then letters, digits and `_`, at most 40 characters. No dots or dashes: Loki rewrites `.` and `-` to `_` in names, so `a.b` and `a_b` would collide. |
| Value | string, finite number or boolean. Anything else (null, undefined, object, array, NaN, Infinity) drops the key. |
| String length | at most 128 characters; longer strings are cut to 128. |
| Count | at most 20 distinct keys in both sets together. A new key beyond 20 is dropped; changing an existing key always works. |

## 4. On the wire

- Each attribute is an OTel attribute named `ouo.attr.<key>` on every span (at start) and every log
  record (at emit) after the call, next to `user.id`. Example: `setAttributes({ tenant: "acme" })`
  gives `ouo.attr.tenant = "acme"`.
- Records about a named session (`session.start`, `session.end`) carry the sets current at their
  emission (see the rotation rule in section 2).
- They are **never Loki index labels**: the collector and Loki config promote a fixed label set
  (`deploy/compose/loki/config.yaml`, `otlp_config`), so `ouo.attr.*` lands in structured
  metadata as `ouo_attr_<key>`. Do not add them to that list: one stream per tenant, plan and
  user would explode cardinality.

## 5. OTA bundle identity (F2)

An over-the-air update replaces the JavaScript bundle without changing `service.version` (the store
build). To tell bundles apart, the React Native SDK takes:

```ts
initRUM({ ..., bundle: { id: HotUpdater.getBundleId(), channel: "production" } });
// or later, once known (CodePush answers asynchronously):
rum.setBundle({ id: metadata.label, channel: metadata.deploymentKey ? "production" : undefined });
```

| Attribute | Value |
|---|---|
| `ouo.app.bundle.id` | the OTA bundle's id, 1 to 128 characters |
| `ouo.app.bundle.channel` | optional release channel, 1 to 64 characters |

- From `initRUM` they are resource attributes (next to `service.version`) **and** stamped on every
  span and log record; from `setBundle` they are stamped on every later span and log record (a
  resource cannot change after the providers exist). rum-api reads either.
- A `setBundle` with an invalid id is ignored; `setBundle(undefined)` clears it.
- Records about a previous run (a crash or `session.end` emitted at the next launch with the old
  `session.id`) are not stamped with this run's attributes or bundle; only the resource carries
  this run's bundle, which rum-api's first-value rule (section 6) ignores.
- The SDK depends on no OTA library. The app passes what its library reports:

| Library | Bundle id | Channel |
|---|---|---|
| hot-updater | `HotUpdater.getBundleId()` (sync) | `HotUpdater.getChannel()` |
| expo-updates | `Updates.updateId` (sync; `null` for the embedded bundle: pass `"embedded"` or nothing) | `Updates.channel` |
| CodePush | `(await codePush.getUpdateMetadata())?.label` (async: use `setBundle`) | the deployment name the app knows |

- Native iOS: not applicable (a native app's code is its store build: `service.version` and
  `ouo.app.build`). The browser: not applicable (a deploy is a new `service.version`).
- The bundle id is the same thing whose source maps `@ouo11y/sourcemaps` uploads per OTA build
  (#156, docs/sourcemaps.md "OTA updates"): symbolication matches by Hermes debug id, so
  `ouo.app.bundle.id` is for grouping and filtering, not for finding maps.

## 6. Session record (rum-api)

| Field | Rule |
|---|---|
| `attributes` | map key → value of the session's `ouo_attr_*` metadata, the latest value of each key over the session's events (a removed key keeps its last value). Omitted when empty. Stripped from each timeline item's `attrs`. |
| `bundle_id`, `bundle_channel` | the first non-empty `ouo_app_bundle_id` (and its event's `ouo_app_bundle_channel`) in time order, like `service_version`: a crash or `session.end` reported on the next launch, under the next bundle, does not move the session. Omitted when empty. |

## 7. Reads (rum-api)

- `GET /v1/sessions` and `GET /v1/stats/health` take any number of `attr.<key>=<value>` query
  parameters: a session matches when its record's `attributes[key] == value` for every one
  (AND), and `bundle=<id>`.
- The filter applies to the folded record (latest values), never to single Loki events: an
  attribute set after `session.start` still matches the whole session. Keys and values never enter
  LogQL; a key that fails the section 3 rule or a value over 128 characters or with a control
  character is a 400.
- Health buckets carry `bundle_id`: one bucket per (platform, service, version, bundle). Sessions
  without a bundle have `bundle_id: ""`, so web and native buckets are unchanged.
