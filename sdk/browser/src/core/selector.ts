/**
 * A CSS selector for a clicked element (PRV-9): tag names, `nth-of-type` and ids only. No class
 * names, no attribute values, no text, and no id that holds a run of six or more digits (such
 * ids are usually generated or user-specific).
 */
const MAX_DEPTH = 6;

function usableId(id: string): boolean {
  return id !== "" && id.length <= 64 && !/\d{6,}/.test(id) && /^[A-Za-z_][\w-]*$/.test(id);
}

export function cssSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < MAX_DEPTH; depth++) {
    const tag = node.localName;
    if (tag === "html" || tag === "body") {
      parts.unshift(tag);
      break;
    }
    if (usableId(node.id)) {
      parts.unshift(`${tag}#${node.id}`);
      break;
    }
    let index = 1;
    let twins = false;
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.localName === tag) index++;
    }
    for (let s = node.nextElementSibling; s && !twins; s = s.nextElementSibling) twins = s.localName === tag;
    parts.unshift(index > 1 || twins ? `${tag}:nth-of-type(${index})` : tag);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/** `data-otel-*` attributes of the element, as one compact string (SIG-10 optional attribute). */
export function otelDataAttributes(el: Element): string | undefined {
  const out: string[] = [];
  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith("data-otel-") && out.length < 8) out.push(`${a.name}=${a.value.slice(0, 128)}`);
  }
  return out.length > 0 ? out.join(";") : undefined;
}
