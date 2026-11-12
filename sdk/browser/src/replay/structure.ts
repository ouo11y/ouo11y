/**
 * The structure format, `rrweb/2`: rrweb records a description of the DOM (a full snapshot, then
 * what its MutationObserver and input listeners see), one JSON event per line. Masking happens
 * here, before any byte leaves the adapter (PRV-5):
 *
 * - every text node is replaced by `***` unless it is inside `data-ouo-unmask` (and not inside
 *   `data-ouo-mask`);
 * - every form value is replaced the same way; password, payment and one-time-code fields cannot
 *   be unmasked; checked and selected states are dropped where the value is masked;
 * - attributes that carry text a person reads (`title`, `alt`, `placeholder`, `aria-label`, ...)
 *   are masked like text;
 * - images, video and canvas are blocked (recorded as an empty box of the same size);
 * - page and link URLs are sanitised (PRV-10).
 *
 * An event that cannot be masked is dropped (PRV-8), and a keyframe is taken so the recording
 * stays decodable.
 */
import { record } from "rrweb";
import { attempt, point } from "../guard";
import type { AdapterOptions, AdapterSink, ReplayAdapter } from "./adapter";
import { BLOCK_SELECTOR, inputMasked, MASKED_TEXT, maskText, textMasked } from "./mask";

/** rrweb `EventType` and `IncrementalSource` values the adapter looks at. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const MUTATION = 0;
const INPUT = 5;
const ELEMENT_NODE = 2;

const TEXT_ATTRIBUTES = new Set(["title", "alt", "placeholder", "aria-label", "aria-description", "aria-valuetext", "label", "value"]);
const FORM_CONTROLS = new Set(["input", "textarea", "select", "option", "button"]);
const URL_ATTRIBUTES = new Set(["href", "action", "formaction", "ping"]);
/** rrweb's own helper iframes (Safari, pages with patched DOM prototypes) are not part of the page. */
const ALWAYS_BLOCKED = "iframe.rr-block";

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

interface RrwebEvent {
  type?: number;
  timestamp?: number;
  data?: {
    href?: string;
    node?: SerializedNode;
    source?: number;
    adds?: Array<{ node: SerializedNode }>;
    attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
    id?: number;
    text?: string;
    isChecked?: boolean;
  };
}

type RecordFn = typeof record & { takeFullSnapshot?: (isCheckout?: boolean) => void; mirror?: { getNode(id: number): Node | null } };

export function createStructureAdapter(o: AdapterOptions): ReplayAdapter {
  const rr = record as RecordFn;
  let stop: (() => void) | undefined;
  let sink: AdapterSink | undefined;
  const encoder = new TextEncoder();

  const element = (id: number): Element | null => {
    const n = rr.mirror?.getNode(id);
    return n && n.nodeType === 1 ? (n as Element) : null;
  };

  const scrubAttributes = (id: number, tag: string | undefined, attrs: Record<string, unknown> | undefined): void => {
    if (!attrs) return;
    const control = FORM_CONTROLS.has(tag ?? "");
    let el: Element | null | undefined;
    let masked: boolean | undefined;
    const isMasked = (): boolean => {
      if (masked === undefined) {
        el = element(id);
        masked = control ? inputMasked(el) : textMasked(el);
      }
      return masked;
    };
    for (const name of Object.keys(attrs)) {
      const v = attrs[name];
      if (control && (name === "checked" || name === "selected")) {
        if (isMasked()) delete attrs[name];
        continue;
      }
      if (typeof v !== "string" || v === "") continue;
      if (URL_ATTRIBUTES.has(name) && tag !== "link") attrs[name] = o.sanitize(v);
      else if (TEXT_ATTRIBUTES.has(name) && isMasked()) attrs[name] = MASKED_TEXT;
    }
  };

  const walk = (n: SerializedNode | undefined): void => {
    if (!n) return;
    if (n.type === ELEMENT_NODE) scrubAttributes(n.id, n.tagName, n.attributes);
    if (n.childNodes) for (const c of n.childNodes) walk(c);
  };

  /** Masks what rrweb's own options do not cover, in place. Throws when it cannot. */
  const scrub = (e: RrwebEvent): void => {
    point("replay.mask");
    const d = e.data;
    if (e.type === META && d?.href) d.href = o.sanitize(d.href);
    else if (e.type === FULL_SNAPSHOT) walk(d?.node);
    else if (e.type === INCREMENTAL && d?.source === MUTATION) {
      for (const a of d.adds ?? []) walk(a.node);
      for (const a of d.attributes ?? []) scrubAttributes(a.id, element(a.id)?.localName, a.attributes);
    } else if (e.type === INCREMENTAL && d?.source === INPUT) {
      // Radios and checkboxes: rrweb masks text-like values only.
      const el = typeof d.id === "number" ? element(d.id) : null;
      if (inputMasked(el)) {
        if (d.text) d.text = MASKED_TEXT;
        d.isChecked = false;
      }
    }
  };

  const onEvent = (event: unknown): void => {
    const s = sink;
    if (!s) return;
    const e = event as RrwebEvent;
    let bytes: Uint8Array;
    try {
      scrub(e);
      bytes = encoder.encode(`${JSON.stringify(e)}\n`);
    } catch {
      s.dropped("mask_failed");
      // What was dropped may be needed to decode what follows: start over from a keyframe.
      if (e.type !== META && e.type !== FULL_SNAPSHOT) attempt(() => rr.takeFullSnapshot?.(true));
      return;
    }
    s.data(bytes, { time: typeof e.timestamp === "number" ? e.timestamp : Date.now(), keyframe: e.type === META });
  };

  return {
    format: "rrweb/2",
    compress: true,
    start(target) {
      sink = target;
      try {
        stop = rr({
          emit: onEvent,
          // `*`: rrweb hands every text node to maskTextFn, which applies the unmask rules.
          maskTextSelector: "*",
          maskTextFn: (text: string, el: HTMLElement | null) => (textMasked(el) ? maskText(text) : text),
          maskAllInputs: true,
          maskInputFn: (text: string, el: HTMLElement) => (inputMasked(el) ? (text === "" ? "" : MASKED_TEXT) : text),
          blockSelector: `${ALWAYS_BLOCKED},${BLOCK_SELECTOR}`,
          recordCanvas: false,
          collectFonts: false,
          inlineImages: false,
          slimDOMOptions: { script: true, comment: true },
          // Mouse moves and scrolls are sampled, so a storm of them stays cheap (GR-CPU-1).
          sampling: { mousemove: 100, scroll: 150, input: "last" },
          // A throw inside rrweb's observers is contained here and never reaches the page.
          errorHandler: () => true,
        } as unknown as Parameters<typeof record>[0]) as (() => void) | undefined;
      } catch (err) {
        target.failed(err);
      }
    },
    requestKeyframe() {
      attempt(() => rr.takeFullSnapshot?.(true));
    },
    stop() {
      sink = undefined;
      const s = stop;
      stop = undefined;
      if (s) attempt(s);
    },
  };
}
