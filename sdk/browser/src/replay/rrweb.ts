/**
 * The lazily loaded replay chunk: rrweb plus the privacy rules that only matter once it records
 * (ADR-0003, revision 2026-11-03). Everything here stays out of the core bundle.
 */
import { record } from "rrweb";

export { record };

/** Privacy classes (ADR-0003); the core's copies are in recorder.ts. */
const BLOCK_CLASS = "ouo-block";
const MASK_TEXT_CLASS = "ouo-mask";
/** Text inside these is recorded as written when `maskAllText` is on. */
const UNMASK_CLASS = "ouo-unmask";
/**
 * Always blocked: rrweb's own helper iframes. Where a page has patched DOM prototypes (Zone.js,
 * another monitoring script) rrweb takes clean ones from a hidden iframe, and on Safari keeps it
 * in the DOM with the class `rr-block`; it is not part of the page the user saw. (rrweb still
 * attaches observers to its idle document at every checkout: project/kb-archive/browser-sdk-safety.md.)
 */
export const ALWAYS_BLOCKED = "iframe.rr-block";

/** Pattern of `replay.excludeRoutes`: an exact path, a path ending in `*` (a prefix), or a RegExp. */
export type RoutePattern = string | RegExp;

/** The `replay` options this chunk reads. */
export interface PrivacyOptions {
  maskAllInputs?: boolean | undefined;
  blockSelector?: string | undefined;
  maskAllText?: boolean | undefined;
  unmaskTextSelector?: string | undefined;
  maskTextSelector?: string | undefined;
  excludeRoutes?: RoutePattern[] | undefined;
}

/**
 * Attributes that carry text a person reads (tooltips, alternative text, accessible names,
 * placeholders) or a value (`value` of any element: `<li>`, `<data>`, `<meter>`). With
 * `maskAllText` they are masked like text nodes outside `ouo-unmask`.
 */
const TEXT_ATTRIBUTES = new Set(["title", "alt", "placeholder", "aria-label", "aria-description", "aria-valuetext", "label", "value"]);
/**
 * Form controls. rrweb's `maskAllInputs` masks the value of text-like inputs only: a radio's or
 * checkbox's `value` and `checked`, an `<option>`'s `value`, a hidden input and a button go out as
 * written, and so does the `text` of a radio or checkbox Input event. With `maskAllInputs` the SDK
 * masks every control's value and drops its checked / selected state, wherever it is.
 */
const FORM_CONTROLS = new Set(["input", "textarea", "select", "option", "button"]);

const mask = (text: string): string => text.replace(/\S/g, "*");

/**
 * Whether `path` (`location.pathname`) matches one of `excludeRoutes`. Only the path: a route
 * template arrives through `setRoute` after the page rendered, too late to keep it out.
 */
export function routeExcluded(patterns: RoutePattern[] | undefined, path: string): boolean {
  if (!patterns) return false;
  return patterns.some((p) => {
    if (typeof p !== "string") {
      p.lastIndex = 0;
      return p.test(path);
    }
    return p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p;
  });
}

export interface Privacy {
  /** Merged into rrweb's `record()` options. */
  options: Record<string, unknown>;
  /** Whether the text of `el` is masked: `ouo-mask`, or outside `ouo-unmask` with `maskAllText`; no element fails closed. */
  textMasked(el: Element | null): boolean;
  /** Masks the text attributes and form values an rrweb event carries, in place; returns the event. */
  scrub<E>(event: E): E;
  /** Whether replay is hidden on this path (`excludeRoutes`). */
  hidden(path: string): boolean;
}

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

interface ReplayEvent {
  type?: number;
  data?: {
    node?: SerializedNode;
    source?: number;
    adds?: Array<{ node: SerializedNode }>;
    attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
    text?: string;
    isChecked?: boolean;
  };
}

/** rrweb-snapshot `NodeType.Element`, rrweb `EventType.FullSnapshot` / `IncrementalSnapshot`, `IncrementalSource.Mutation` / `Input`. */
const ELEMENT_NODE = 2;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const MUTATION = 0;
const INPUT = 5;

export function createPrivacy(o: PrivacyOptions = {}): Privacy {
  const maskAll = o.maskAllText !== false;
  const maskInputs = o.maskAllInputs !== false;
  const maskSelector = o.maskTextSelector ? `.${MASK_TEXT_CLASS},${o.maskTextSelector}` : `.${MASK_TEXT_CLASS}`;
  const unmaskSelector = o.unmaskTextSelector ? `.${UNMASK_CLASS},${o.unmaskTextSelector}` : `.${UNMASK_CLASS}`;

  const textMasked = (el: Element | null): boolean => {
    if (!el || typeof el.closest !== "function") return true;
    try {
      if (el.closest(maskSelector)) return true;
      return maskAll && !el.closest(unmaskSelector);
    } catch {
      // An invalid selector of the host: fail closed.
      return true;
    }
  };

  // The live node behind a serialized id; rrweb fills its mirror before it emits.
  const element = (id: number): Element | null => {
    const n = (record as { mirror?: { getNode(id: number): Node | null } }).mirror?.getNode(id);
    return n && n.nodeType === 1 ? (n as Element) : null;
  };

  const scrubAttributes = (id: number, tag: string | undefined, attrs: Record<string, unknown> | undefined): void => {
    if (!attrs) return;
    // A control's value and state follow `maskAllInputs` alone.
    const control = FORM_CONTROLS.has(tag ?? "");
    let masked: boolean | undefined;
    for (const name of Object.keys(attrs)) {
      const v = attrs[name];
      if (control && maskInputs && (name === "checked" || name === "selected")) {
        delete attrs[name];
        continue;
      }
      if (typeof v !== "string" || !v) continue;
      if (control && name === "value") {
        if (maskInputs) attrs[name] = mask(v);
        continue;
      }
      if (!maskAll || !TEXT_ATTRIBUTES.has(name)) continue;
      masked ??= textMasked(element(id));
      if (masked) attrs[name] = mask(v);
    }
  };

  const walk = (n: SerializedNode | undefined): void => {
    if (!n) return;
    if (n.type === ELEMENT_NODE) scrubAttributes(n.id, n.tagName, n.attributes);
    if (n.childNodes) for (const c of n.childNodes) walk(c);
  };

  const options: Record<string, unknown> = {
    maskAllInputs: o.maskAllInputs !== false,
    blockClass: BLOCK_CLASS,
    maskTextClass: MASK_TEXT_CLASS,
    blockSelector: o.blockSelector ? `${ALWAYS_BLOCKED}, ${o.blockSelector}` : ALWAYS_BLOCKED,
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    slimDOMOptions: { script: true, comment: true },
  };
  // `*`: rrweb hands every text node to maskTextFn, which applies the allow-list.
  if (maskAll) Object.assign(options, { maskTextSelector: "*", maskTextFn: (text: string, el: HTMLElement | null) => (textMasked(el) ? mask(text) : text) });
  else if (o.maskTextSelector) options.maskTextSelector = o.maskTextSelector;

  return {
    options,
    textMasked,
    scrub(event) {
      const e = event as ReplayEvent;
      const d = e.data;
      if (e.type === FULL_SNAPSHOT) walk(d?.node);
      else if (e.type === INCREMENTAL && d?.source === MUTATION) {
        for (const a of d.adds ?? []) walk(a.node);
        for (const a of d.attributes ?? []) scrubAttributes(a.id, element(a.id)?.tagName.toLowerCase(), a.attributes);
      } else if (e.type === INCREMENTAL && d?.source === INPUT && maskInputs) {
        // A radio's or checkbox's value and state; text-like values are already `*`.
        if (d.text) d.text = mask(d.text);
        d.isChecked = false;
      }
      return event;
    },
    hidden: (path) => routeExcluded(o.excludeRoutes, path),
  };
}
