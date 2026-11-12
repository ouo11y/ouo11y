/**
 * The pixel format, `ouo.frames/1`: images of the viewport, taken when the DOM changes.
 *
 * When to look: a MutationObserver, scroll, resize and input events mark the page dirty; a frame
 * is taken at most `pixelMaxFps` times a second, and never while the page is hidden or unchanged.
 * What is recorded: the page is cloned, the clone is masked, and the masked clone is drawn (SVG
 * `foreignObject` to a canvas) and encoded as WebP or JPEG. The live page is never drawn, so an
 * unmasked pixel cannot leave the device: masking runs on the clone before anything is rendered,
 * and a frame whose masking or drawing fails is dropped (PRV-8).
 *
 * Masking in the clone: every text node outside `data-ouo-unmask` becomes `*` per character
 * (the layout is kept, the words are not), form values are removed, and images, video, canvas and
 * frames are replaced by grey boxes of the same size.
 *
 * Every frame is a full image, so every frame is a keyframe and any chunk decodes alone.
 *
 * Wire format: a sequence of records, each `u32 header length | header JSON (UTF-8) | u32 payload
 * length | payload`, big endian. Header: `{ t, k: "frame", w, h, vw, vh, sx, sy, dpr, mime,
 * masked }` (payload: the image) or `{ t, k: "pointer", x, y, p }` (no payload).
 *
 * Known limits (documented in the README): styles from cross-origin stylesheets, web fonts,
 * the scroll position of inner scroll containers and anything painted outside the DOM (canvas,
 * video, plugins) are not reproduced.
 */
import type { Clock, TimerHandle } from "../core/clock";
import { systemClock } from "../core/clock";
import { attempt, guard, listen, point, quiet } from "../guard";
import type { AdapterOptions, AdapterSink, ReplayAdapter } from "./adapter";
import { blocked, inputMasked, textMasked } from "./mask";

export const FRAMES_FORMAT = "ouo.frames/1";
const XHTML = "http://www.w3.org/1999/xhtml";
/** A capture that takes longer than this share of the interval makes the next one wait longer. */
const COST_FACTOR = 10;
const MAX_INTERVAL_MS = 10_000;
/** Pages larger than this are not cloned: the frame is skipped and counted. */
const MAX_NODES = 20_000;

/** One record of the format. */
export function frameRecord(header: Record<string, unknown>, payload?: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const size = payload?.byteLength ?? 0;
  const out = new Uint8Array(8 + head.byteLength + size);
  const view = new DataView(out.buffer);
  view.setUint32(0, head.byteLength);
  out.set(head, 4);
  view.setUint32(4 + head.byteLength, size);
  if (payload) out.set(payload, 8 + head.byteLength);
  return out;
}

/** Decodes a payload of the format (tests, and a reference for readers). */
export function decodeFrames(bytes: Uint8Array): Array<{ header: Record<string, unknown>; payload: Uint8Array }> {
  const out: Array<{ header: Record<string, unknown>; payload: Uint8Array }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 8 <= bytes.byteLength) {
    const hl = view.getUint32(off);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(off + 4, off + 4 + hl))) as Record<string, unknown>;
    const pl = view.getUint32(off + 4 + hl);
    out.push({ header, payload: bytes.subarray(off + 8 + hl, off + 8 + hl + pl) });
    off += 8 + hl + pl;
  }
  return out;
}

const SKIP = new Set(["script", "noscript", "link", "meta", "base", "template", "head", "title"]);
const REPLACED = new Set(["img", "picture", "video", "audio", "canvas", "embed", "object", "iframe", "frame"]);

function placeholder(doc: Document, live: Element): Element {
  const box = doc.createElementNS(XHTML, "div");
  const r = live.getBoundingClientRect();
  const display = attempt(() => getComputedStyle(live).display, "inline-block");
  box.setAttribute(
    "style",
    `display:${display === "inline" ? "inline-block" : display};width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:#d0d0d0;box-sizing:border-box`,
  );
  return box;
}

/**
 * A masked copy of `live` in `doc`. Built node by node from the live tree, so nothing is copied
 * that was not looked at: unknown node types are left out.
 */
export function maskedClone(doc: Document, live: Node, budget: { nodes: number }): Node | null {
  if (budget.nodes-- <= 0) throw new Error("page too large for a pixel frame");
  if (live.nodeType === 3) {
    const text = live.nodeValue ?? "";
    const parent = live.parentElement;
    return doc.createTextNode(textMasked(parent) ? text.replace(/\S/g, "*") : text);
  }
  if (live.nodeType !== 1) return null;
  const el = live as Element;
  const tag = el.localName;
  if (SKIP.has(tag)) return null;
  if (tag === "style") {
    // Inline style sheets are needed for layout; they are text the author wrote, not user data.
    const style = doc.createElementNS(XHTML, "style");
    style.textContent = el.textContent ?? "";
    return style;
  }
  if (REPLACED.has(tag) || blocked(el)) return placeholder(doc, el);
  const svg = el.namespaceURI === "http://www.w3.org/2000/svg";
  const copy = svg ? doc.createElementNS(el.namespaceURI, el.tagName) : doc.createElementNS(XHTML, tag);
  const control = tag === "input" || tag === "textarea" || tag === "select" || tag === "option";
  const masked = control ? inputMasked(el) : textMasked(el);
  for (const a of Array.from(el.attributes)) {
    const name = a.name;
    // Event handlers and anything that loads a resource are not needed to draw the frame.
    if (name.startsWith("on") || name === "src" || name === "srcset" || name === "href" || name === "action" || name === "xlink:href") continue;
    if (masked && (name === "value" || name === "placeholder" || name === "title" || name === "alt" || name === "aria-label" || name === "checked" || name === "selected")) continue;
    attempt(() => copy.setAttribute(name, a.value));
  }
  if (control && !masked) {
    // The live value is a property, not an attribute.
    const v = (el as HTMLInputElement).value;
    if (tag === "input" && typeof v === "string") copy.setAttribute("value", v);
    if (tag === "input" && (el as HTMLInputElement).checked) copy.setAttribute("checked", "");
    if (tag === "option" && (el as HTMLOptionElement).selected) copy.setAttribute("selected", "");
  }
  if (tag === "textarea") {
    copy.textContent = masked ? "" : (el as HTMLTextAreaElement).value;
    return copy;
  }
  const root = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  for (let c: Node | null = (root ?? el).firstChild; c; c = c.nextSibling) {
    const child = maskedClone(doc, c, budget);
    if (child) copy.appendChild(child);
  }
  return copy;
}

/** The CSS of every style sheet the page can read. Cross-origin sheets are skipped. */
function collectCss(): string {
  let css = "";
  const sheets = [...Array.from(document.styleSheets), ...((document as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    try {
      // `<style>` elements are copied with the DOM; only linked and constructed sheets are added here.
      if (sheet.ownerNode && (sheet.ownerNode as Element).localName === "style") continue;
      for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
    } catch {
      // A cross-origin sheet without CORS: unreadable.
    }
  }
  // Nothing in the frame may load from the network.
  return css.replace(/@import[^;]+;/g, "").replace(/url\((?!["']?data:)[^)]*\)/g, "none");
}

export function createPixelAdapter(o: AdapterOptions, clock: Clock = systemClock): ReplayAdapter {
  let sink: AdapterSink | undefined;
  let dirty = true;
  let busy = false;
  let timer: TimerHandle | null = null;
  let observer: MutationObserver | null = null;
  let offs: Array<() => void> = [];
  let last = 0;
  let cost = 0;
  let previous = "";
  let css: { at: number; text: string } | null = null;
  const minInterval = 1000 / o.pixelMaxFps;

  const schedule = (): void => {
    if (!sink || timer !== null || busy || !dirty) return;
    if (document.visibilityState === "hidden") return;
    // Self-budget (GR-CPU-2): the slower a frame was, the longer until the next.
    const interval = Math.min(MAX_INTERVAL_MS, Math.max(minInterval, cost * COST_FACTOR));
    timer = clock.setTimeout(() => {
      timer = null;
      void quiet(capture());
    }, Math.max(0, last + interval - clock.now()));
  };

  const mark = (): void => {
    dirty = true;
    schedule();
  };

  const capture = async (): Promise<void> => {
    const s = sink;
    if (!s || busy) return;
    busy = true;
    dirty = false;
    const t0 = performance.now();
    const time = clock.now();
    try {
      point("replay.mask");
      const vw = Math.max(1, globalThis.innerWidth);
      const vh = Math.max(1, globalThis.innerHeight);
      const sx = Math.round(globalThis.scrollX);
      const sy = Math.round(globalThis.scrollY);
      const doc = document.implementation.createHTMLDocument("");
      const body = maskedClone(doc, document.body, { nodes: MAX_NODES });
      if (!body) throw new Error("nothing to draw");
      if (!css || time - css.at > 5000) css = { at: time, text: collectCss() };
      const html = doc.createElementNS(XHTML, "html");
      for (const a of Array.from(document.documentElement.attributes)) if (!a.name.startsWith("on")) attempt(() => html.setAttribute(a.name, a.value));
      const style = doc.createElementNS(XHTML, "style");
      style.textContent = css.text;
      html.appendChild(style);
      html.appendChild(body);
      const height = Math.max(vh, document.documentElement.scrollHeight);
      const markup = new XMLSerializer().serializeToString(html);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${sx} ${sy} ${vw} ${vh}">` +
        `<foreignObject x="0" y="0" width="${Math.max(vw, document.documentElement.scrollWidth)}" height="${height}">${markup}</foreignObject></svg>`;
      // Unchanged since the last frame: a static page sends nothing.
      if (svg === previous) return;
      const scale = Math.min(1, o.pixelMaxSide / Math.max(vw, vh));
      const image = await draw(svg, Math.round(vw * scale), Math.round(vh * scale));
      if (!sink) return;
      previous = svg;
      s.data(frameRecord({ t: time, k: "frame", w: image.width, h: image.height, vw, vh, sx, sy, dpr: globalThis.devicePixelRatio ?? 1, mime: image.mime, masked: true }, image.bytes), { time, keyframe: true });
    } catch (err) {
      if (!sink) return;
      s.dropped("mask_failed");
      // A canvas the browser will not read back cannot work on this page at all.
      if ((err as { name?: string } | null)?.name === "SecurityError") s.failed(err);
    } finally {
      busy = false;
      last = clock.now();
      cost = performance.now() - t0;
      schedule();
    }
  };

  return {
    format: FRAMES_FORMAT,
    compress: false,
    start(target) {
      sink = target;
      dirty = true;
      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(guard(mark));
        attempt(() => observer!.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }));
      }
      const passive = { capture: true, passive: true } as const;
      offs = [
        listen(globalThis, "scroll", mark, passive),
        listen(globalThis, "resize", mark, passive),
        listen(document, "input", mark, passive),
        listen(document, "visibilitychange", mark),
        listen(document, "pointerdown", (e) => {
          const p = e as PointerEvent;
          sink?.data(frameRecord({ t: clock.now(), k: "pointer", x: Math.round(p.clientX), y: Math.round(p.clientY), p: "down" }), { time: clock.now(), keyframe: false });
        }, passive),
      ];
      schedule();
    },
    requestKeyframe() {
      // Every frame is a keyframe: forget the last one so the next capture sends a frame.
      previous = "";
      mark();
    },
    stop() {
      sink = undefined;
      observer?.disconnect();
      observer = null;
      for (const off of offs) off();
      offs = [];
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

async function draw(svg: string, width: number, height: number): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }> {
  const img = new Image();
  img.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the frame could not be rendered"));
  });
  // A data URL, not a blob URL: a blob SVG taints the canvas in Chromium.
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    try {
      canvas.toBlob(resolve, "image/webp", 0.5);
    } catch (err) {
      reject(err);
    }
  });
  if (!blob) throw new Error("the frame could not be encoded");
  // Browsers without WebP encoding answer with PNG; ask for JPEG instead.
  const final = blob.type === "image/webp" ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.5));
  if (!final) throw new Error("the frame could not be encoded");
  return { bytes: new Uint8Array(await final.arrayBuffer()), mime: final.type, width, height };
}
