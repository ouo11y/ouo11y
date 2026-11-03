# Masking proof: what a replay contains (web and iOS)

What ouo's session replay records of the screen a user sees, shown side by side: the live
screen, then the same moment as stored by rum-api and played in the Grafana app. Captured on
2026-10-23 (web text masking updated 2026-11-03, see below) on `ouo-env 8b-retention-deletion` from this repository's SDKs and example apps
(`@ouo11y/browser`, `@ouo11y/react-native` with the `OuoReplay` iOS module), with fake data typed
by hand. Masking happens on the device, before anything is sent: what is masked never leaves
the browser or the phone, so neither the collector, rum-api nor Grafana ever holds it.

## Web (`@ouo11y/browser`, rrweb)

**Since 0.4.0 (ADR-0003, revision 2026-11-03) all text is masked by default.** Every input value
(`replay.maskAllInputs: true`) and every text node (`replay.maskAllText: true`) is recorded with
each character replaced by `*`, and so are the attributes `title`, `alt`, `placeholder`,
`aria-label`, `aria-description`, `aria-valuetext`, `label` and a button input's `value`. Text is
recorded as written only inside an element with class `ouo-unmask` (or matching
`replay.unmaskTextSelector`); `ouo-mask` masks again inside it, and `ouo-block` elements are not
recorded at all (a placeholder of the same size). Routes in `replay.excludeRoutes` record
nothing; the replay carries an `ouo.replay.hidden` marker for the gap.

Proof of the 0.4 default, in Chromium, Firefox and WebKit (2026-11-03,
`sdk/browser/e2e/sdk.spec.ts`, "replay masks all text outside ouo-unmask and records nothing on a
never-record route", run against the e2e collector stub): the page shows `Jane Doe, born 1970`
with a `title="Patient Jane Doe"`, a button `Open patient record`, an `ouo-unmask` block with an
`ouo-mask` line inside, and a never-record route `/patients/*` whose page (rendered in the same
task as the `pushState`, plus a line added 50 ms later) reads `Diagnosis: confidential` and
`Later on the record page`, both inside `ouo-unmask`. In the uploaded rrweb chunks, `Jane`,
`1970`, `Open patient record`, the masked line, `Diagnosis` and `Later on the record page` occur
nowhere; `Public heading` (in `ouo-unmask`) and `Patient list` (the page after leaving the route)
do; the `ouo.replay.hidden` marker is followed by a fresh full snapshot; and the timeline has one
`ouo.replay.hidden` event with `ouo.replay.hidden_reason: route`. The jsdom tests
`sdk/browser/test/privacy.test.ts` and `privacy.integration.test.ts` check the same rules with
rrweb's real recorder, including added nodes, text changes and attribute changes.

The screenshots below were captured on 2026-10-23 with 0.3, which recorded page text (headings,
product names, prices); they still show the input masking, which is unchanged. With 0.4 the
same replay shows asterisks for the checkout's labels too; `examples/ouo-web` now marks its public
header, catalogue and chaos panel `ouo-unmask` and keeps the cart, checkout and account footer
masked. A Grafana re-capture of the 0.4 default is a follow-up.

| Live page (what the user saw) | Replay in Grafana (end of the session) |
|---|---|
| ![Checkout with name, email and a test card number typed in](masking-proof/web-1-live-checkout.jpg) | ![The same checkout in the replay: the three fields are empty](masking-proof/web-2-replay-checkout.jpg) |

Typed: `Ada Testperson`, `ada@example.test` and the card test number `4242 4242 4242 4242`
(session `a1cf5bb4…`, examples/ouo-web, Chromium). The replay shows the fields without their
values. In the stored events (`GET /v1/sessions/{id}/replay/events`, 33 rrweb events) the four
input events carry only asterisks (`*`, `**************`, `****************`,
`*******************`); `Ada`, `Testperson` and `example.test` occur nowhere, and `4242 4242`
occurs only as the card field's `placeholder` attribute, which is page markup, not user input.

## iOS (`@ouo11y/react-native` + `OuoReplay`, JPEG frames)

Defaults: `maskText`, `maskInputs`, `maskImages`, `maskWebViews` all `true`. Every label, React
Native `<Text>`, text input, image and web view is painted black on the device before the frame
is encoded (`sdk/ios/README.md` lists the classes). `testID="ouo-unmask"` keeps a view readable,
`testID="ouo-mask"` redacts one whatever the options say. The example app marks the product title
`ouo-unmask` and the promo-code field `ouo-mask`.

Recorded with the SDK defaults (`replay: { enabled: true }`, session `19e3f5dd…`, iOS 27
Simulator, frames as stored by rum-api, `GET /v1/sessions/{id}/replay/frames`):

| Live screen | Stored frame |
|---|---|
| ![Product list with names and prices](masking-proof/ios-1-live-products.jpg) | ![Product list frame: every name and price is a black bar](masking-proof/ios-2-replay-products.jpg) |
| ![Product page: title, price, Add to cart](masking-proof/ios-3-live-product.jpg) | ![Product page frame: only the ouo-unmask title is readable](masking-proof/ios-4-replay-product.jpg) |
| ![Checkout with ADA SECRET typed into the promo code, keyboard open](masking-proof/ios-5-live-checkout-typed.jpg) | ![Checkout frame: labels, the promo field and the Pay title are black bars](masking-proof/ios-6-replay-checkout.jpg) |

The same replay in the Grafana app, at its last frame (the tap on the `ouo-mask` promo field is
the touch indicator):

![Grafana replay player showing the masked checkout frame and the tap timeline](masking-proof/ios-7-grafana-player.jpg)

What the frames show:

- No text the user saw or typed is readable except the view marked `ouo-unmask`; the
  navigation-bar back chevron (an image) is masked too.
- `ADA SECRET` typed into the promo code appears in no frame. The recorder drops a frame whose
  redacted image equals the previous one, so typing into a field that is already a black box
  adds no frame at all: the recording has 9 frames, the last one taken before the typing.
- The software keyboard, including its suggestion bar (which echoed `SECRET` on the live
  screen), is in none of the frames.
- The replay is flagged `masked: true` per chunk and for the session.

**Opting out of label masking.** `examples/ouo-mobile` ships with `maskText: false` so its demo
replays stay readable. Inputs and images stay masked, and `ouo-mask` still applies (session
`b49984b5…`, same build otherwise):

| Product page, `maskText: false` | Checkout, `maskText: false` |
|---|---|
| ![Product page frame with readable labels and a masked back chevron](masking-proof/ios-8-replay-product-masktext-off.jpg) | ![Checkout frame with readable labels and the promo field black](masking-proof/ios-9-replay-checkout-masktext-off.jpg) |

## Reproduce

1. `deploy/envs/ouo-env up <env>`.
2. Web: `examples/ouo-web/scripts/run.sh --env <env>` builds the app; serve `examples/ouo-web/dist`
   (`npx vite preview --port 4173`), type into the checkout form, open the session in the ouo11y
   RUM app, and check `GET /v1/sessions/{id}/replay/events` for your values.
3. iOS: `examples/ouo-mobile/scripts/build-ios.sh --env <env> --device <simulator udid>` (set
   `replay: { enabled: true }` in `examples/ouo-mobile/src/rum.ts` for the defaults), drive the
   app, background it to flush, and decode the frames from `GET /v1/sessions/{id}/replay/frames`
   (`jpeg` is base64).

## Limits of this proof

- The iOS Simulator, not a physical iPhone (the device was in use for benchmarks). The redaction
  runs in the same Swift code on a device; a device capture is not part of this proof.
- Masking is by view class and test id. A custom view that draws text itself (a chart, a
  canvas, a custom-drawn label) is not a known class: add its class to `maskClasses` or mark it
  `ouo-mask`. On the web, text rendered into a `<canvas>` is not recorded (canvas recording is
  off); text in ordinary elements is masked unless it is inside `ouo-unmask` (0.4 default), and
  text in a shadow root stays masked even under an `ouo-unmask` host.
- Telemetry other than replay (event attributes, URLs, span attributes) is not masked by these
  options; what the app puts there is what is sent. The one exception: web click names
  (`app.widget.name`) follow `maskAllText` (only `data-testid` outside `ouo-unmask`).
- React Native never-record screens (`replay.excludeScreens`, `rum.replay.hideScreen()`) are
  covered by unit tests of the JS controller, not by a simulator capture in this proof.

A data processing agreement template is legal material and lives outside this repository.
