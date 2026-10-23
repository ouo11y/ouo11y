import { BLOCK_CLASS, MASK_TEXT_CLASS } from "../replay/recorder";

/** Elements a user clicks on purpose; a click inside one is attributed to it. */
const ACTIONABLE =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="option"],[onclick],[data-testid]';

const MAX_NAME = 64;

export interface ElementDescription {
  /** `app.widget.id`: a short CSS-like path, `button#buy.btn.primary[data-testid=buy]`. */
  id: string;
  /** `app.widget.name`: aria-label, data-testid, the text of a button or link, title, or name. */
  name: string;
}

/** The element a click is about: the closest actionable ancestor, else the target itself. */
export function clickTarget(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  const el = target as Element;
  return el.closest(ACTIONABLE) ?? el;
}

/**
 * Pure description of an element for click spans and rage / dead click events. Text is only
 * read from buttons and links, and never inside the replay privacy classes (`ouo-mask`,
 * `ouo-block`); input values are never read.
 */
export function describeElement(el: Element): ElementDescription {
  const tag = el.tagName.toLowerCase();
  let id = tag;
  if (el.id) id += `#${el.id}`;
  const classes = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 2) : [];
  for (const c of classes) id += `.${c}`;
  const testId = el.getAttribute("data-testid");
  if (testId) id += `[data-testid=${testId}]`;

  const masked = el.closest(`.${MASK_TEXT_CLASS},.${BLOCK_CLASS}`) !== null;
  const attr = (n: string): string => (el.getAttribute(n) ?? "").trim();
  let name = attr("aria-label") || testId || "";
  if (!name && !masked && isTextLabelled(el, tag)) {
    name = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  if (!name) name = attr("title") || attr("name");
  if (masked && name && !testId) name = "";
  return { id, name: name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name };
}

function isTextLabelled(el: Element, tag: string): boolean {
  if (tag === "button" || tag === "a" || tag === "summary") return true;
  if (tag === "input") return ["button", "submit", "reset"].includes((el as HTMLInputElement).type);
  const role = el.getAttribute("role");
  return role === "button" || role === "link" || role === "menuitem" || role === "tab";
}

/**
 * Whether a click on `el` that changed nothing is a dead click. Form fields, labels and
 * checkboxes change state without touching the DOM, and a link or submit button whose default
 * was not prevented leaves the page (a full navigation), so none of those count.
 */
export function isDeadClickCandidate(el: Element, defaultPrevented: boolean): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "select" || tag === "textarea" || tag === "label" || tag === "option") return false;
  if ((el as HTMLElement).isContentEditable) return false;
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type !== "button" && type !== "submit" && type !== "reset" && type !== "image") return false;
    if (type === "submit" && !defaultPrevented && (el as HTMLInputElement).form) return false;
    return !(el as HTMLInputElement).disabled;
  }
  if (tag === "a") {
    if ((el as HTMLAnchorElement).hasAttribute("href") && !defaultPrevented) return false;
    return true;
  }
  if (tag === "button") {
    const b = el as HTMLButtonElement;
    if (b.disabled) return false;
    if (b.type === "submit" && b.form && !defaultPrevented) return false;
    return true;
  }
  const role = el.getAttribute("role");
  return role === "button" || role === "link" || role === "menuitem" || role === "tab";
}
