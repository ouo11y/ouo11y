/**
 * Replay privacy (ADR-0003, revision 2026-11-03): mask all text by default, the `ouo-unmask`
 * allow-list, `ouo-mask` and `ouo-block` precedence, text attributes, never-record routes and
 * click names. The rrweb cases run the real recorder in jsdom.
 */
import { afterEach, describe, expect, it } from "vitest";
import { describeElement } from "../src/interactions/element";
import { ALWAYS_BLOCKED, createPrivacy, record, routeExcluded, type PrivacyOptions } from "../src/replay/rrweb";

interface SNode {
  type: number;
  id: number;
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, string>;
  childNodes?: SNode[];
}

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body;
}

/** Records the current document with the privacy options and returns the events. */
function recordPage(o: PrivacyOptions = {}): { events: Array<{ type: number; data: Record<string, unknown> }>; stop: () => void } {
  const p = createPrivacy(o);
  const events: Array<{ type: number; data: Record<string, unknown> }> = [];
  const stop = record({ emit: (e: unknown) => void events.push(p.scrub(e) as never), ...p.options } as never)!;
  return { events, stop };
}

function texts(n: SNode | undefined, out: string[] = []): string[] {
  if (!n) return out;
  if (n.type === 3 && n.textContent?.trim()) out.push(n.textContent.trim());
  for (const c of n.childNodes ?? []) texts(c, out);
  return out;
}

function elements(n: SNode | undefined, out: SNode[] = []): SNode[] {
  if (!n) return out;
  if (n.type === 2) out.push(n);
  for (const c of n.childNodes ?? []) elements(c, out);
  return out;
}

const snapshotRoot = (events: Array<{ type: number; data: Record<string, unknown> }>): SNode => events.find((e) => e.type === 2)!.data.node as SNode;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("textMasked", () => {
  it("masks every element by default, records inside ouo-unmask, and ouo-mask wins inside it", () => {
    const p = createPrivacy();
    html('<p id="a">x</p><div class="ouo-unmask"><p id="b">x</p><div class="ouo-mask"><p id="c">x</p><div class="ouo-unmask"><p id="d">x</p></div></div></div>');
    const el = (id: string) => document.getElementById(id);
    expect(p.textMasked(el("a"))).toBe(true);
    expect(p.textMasked(el("b"))).toBe(false);
    expect(p.textMasked(el("c"))).toBe(true);
    // An unmask inside a mask stays masked: masking wins at any depth.
    expect(p.textMasked(el("d"))).toBe(true);
  });

  it("applies unmaskTextSelector and maskTextSelector like the classes", () => {
    const p = createPrivacy({ unmaskTextSelector: "[data-public]", maskTextSelector: ".pii" });
    html('<section data-public><h1 id="a">x</h1><span class="pii" id="b">x</span></section><p id="c">x</p>');
    expect(p.textMasked(document.getElementById("a"))).toBe(false);
    expect(p.textMasked(document.getElementById("b"))).toBe(true);
    expect(p.textMasked(document.getElementById("c"))).toBe(true);
  });

  it("with maskAllText false only ouo-mask and maskTextSelector mask", () => {
    const p = createPrivacy({ maskAllText: false, maskTextSelector: ".pii" });
    html('<p id="a">x</p><p class="ouo-mask" id="b">x</p><p class="pii" id="c">x</p>');
    expect(p.textMasked(document.getElementById("a"))).toBe(false);
    expect(p.textMasked(document.getElementById("b"))).toBe(true);
    expect(p.textMasked(document.getElementById("c"))).toBe(true);
    expect(p.options.maskTextSelector).toBe(".pii");
    expect(p.options.maskTextFn).toBeUndefined();
  });

  it("fails closed without an element and with an invalid selector", () => {
    expect(createPrivacy().textMasked(null)).toBe(true);
    html('<p id="a" class="ouo-unmask">x</p>');
    expect(createPrivacy({ unmaskTextSelector: "[[nope" }).textMasked(document.getElementById("a"))).toBe(true);
  });

  it("keeps the rrweb options of ADR-0003", () => {
    const o = createPrivacy({ blockSelector: ".grid" }).options;
    expect(o).toMatchObject({ maskAllInputs: true, blockClass: "ouo-block", maskTextClass: "ouo-mask", maskTextSelector: "*", recordCanvas: false, inlineImages: false });
    expect(o.blockSelector).toBe(`${ALWAYS_BLOCKED}, .grid`);
    expect(createPrivacy({ maskAllInputs: false }).options.maskAllInputs).toBe(false);
  });
});

describe("rrweb recording with mask-all-text", () => {
  it("masks text and text attributes outside ouo-unmask, and blocks ouo-block", () => {
    html(
      '<h1>Jane Doe</h1><img alt="Photo of Jane" src="data:,"><button title="Delete Jane" aria-label="Delete Jane">Delete</button>' +
        '<input type="submit" value="Sign for Jane">' +
        '<div class="ouo-unmask"><h2>Appointments</h2><span title="Open">Open</span><span class="ouo-mask">Room 4</span></div>' +
        '<div class="ouo-unmask"><div class="ouo-block"><p>Diagnosis</p></div></div>',
    );
    const { events, stop } = recordPage();
    stop();
    const root = snapshotRoot(events);
    const all = texts(root);
    expect(all).toContain("Appointments");
    expect(all).toContain("Open");
    expect(all).toContain("**** ***");
    expect(all).toContain("******");
    expect(all).toContain("**** *");
    const json = JSON.stringify(root);
    for (const secret of ["Jane", "Delete", "Room 4", "Diagnosis"]) expect(json).not.toContain(secret);
    const byTag = (t: string) => elements(root).filter((e) => e.tagName === t);
    expect(byTag("img")[0]!.attributes!.alt).toBe("***** ** ****");
    expect(byTag("button")[0]!.attributes!["aria-label"]).toBe("****** ****");
    expect(byTag("input")[0]!.attributes!.value).toMatch(/^\*+ \*+ \*+$/);
    // Inside ouo-unmask attributes stay.
    expect(byTag("span")[0]!.attributes!.title).toBe("Open");
  });

  it("masks added nodes, text changes and attribute changes the same way", async () => {
    html('<div id="out"></div><div class="ouo-unmask" id="in"></div>');
    const { events, stop } = recordPage();
    const out = document.getElementById("out")!;
    const inside = document.getElementById("in")!;
    out.innerHTML = '<p title="Jane Doe">Jane Doe</p>';
    inside.innerHTML = '<p title="Visible">Visible</p>';
    await tick();
    out.firstElementChild!.firstChild!.textContent = "John Roe";
    out.firstElementChild!.setAttribute("title", "John Roe");
    await tick();
    stop();
    const mutations = JSON.stringify(events.filter((e) => e.type === 3));
    expect(mutations).not.toContain("Jane");
    expect(mutations).not.toContain("John");
    expect(mutations).toContain("Visible");
    expect(mutations).toContain("**** ***");
  });

  it("records text as before with maskAllText false", () => {
    html("<h1>Jane Doe</h1><p class=\"ouo-mask\">Room 4</p>");
    const { events, stop } = recordPage({ maskAllText: false });
    stop();
    const all = texts(snapshotRoot(events));
    expect(all).toContain("Jane Doe");
    expect(all).toContain("**** *");
  });
});

describe("routeExcluded", () => {
  it("matches exact paths, `*` prefixes, RegExps and the route template", () => {
    const routes = ["/patients", "/patients/*", /^\/sign\/[0-9]+$/g, "/identity/:step"];
    expect(routeExcluded(routes, "/patients")).toBe(true);
    expect(routeExcluded(routes, "/patients/42/notes")).toBe(true);
    expect(routeExcluded(routes, "/patientsX")).toBe(false);
    // A global RegExp is stateful; every check starts at 0.
    expect(routeExcluded(routes, "/sign/7")).toBe(true);
    expect(routeExcluded(routes, "/sign/7")).toBe(true);
    expect(routeExcluded(routes, "/identity/selfie")).toBe(false);
    expect(routeExcluded(routes, "/identity/selfie", "/identity/:step")).toBe(true);
    expect(routeExcluded(undefined, "/patients")).toBe(false);
    expect(routeExcluded(["/"], "/home")).toBe(false);
  });
});

describe("click names with maskAllText", () => {
  const UNMASK = ".ouo-unmask";
  const name = (markup: string, unmask: string | null = UNMASK, mask?: string) => describeElement(html(markup).querySelector("button")!, unmask ?? undefined, mask).name;

  it("names a click by its data-testid alone outside ouo-unmask", () => {
    expect(name("<button>Delete Jane</button>")).toBe("");
    expect(name('<button aria-label="Delete Jane" title="t" name="n">x</button>')).toBe("");
    expect(name('<button data-testid="delete" aria-label="Delete Jane">Delete Jane</button>')).toBe("delete");
  });

  it("reads text inside ouo-unmask, not inside ouo-mask, maskTextSelector or ouo-block", () => {
    expect(name('<div class="ouo-unmask"><button>Save</button></div>')).toBe("Save");
    expect(name('<div class="ouo-unmask"><div class="ouo-mask"><button>Pay</button></div></div>')).toBe("");
    expect(name('<div class="ouo-unmask"><div class="pii"><button>Pay</button></div></div>', UNMASK, ".pii")).toBe("");
    expect(name('<div class="ouo-unmask ouo-block"><button>Pay</button></div>')).toBe("");
  });

  it("keeps the old rule with maskAllText off, and fails closed on an invalid selector", () => {
    expect(name("<button>Save</button>", null)).toBe("Save");
    expect(name('<div class="ouo-mask"><button data-testid="pay" aria-label="Pay 4242">Pay</button></div>', null)).toBe("pay");
    expect(name('<div class="ouo-unmask"><button>Save</button></div>', "[[nope")).toBe("");
  });
});
