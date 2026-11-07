import { parseHTML } from "linkedom";

const ACTIVE_ELEMENTS = "base, form, object, embed, iframe";
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "poster", "data", "action", "formaction", "srcset"]);
const FORBIDDEN_URL = /^\s*(?:\/\/|https?:|file:|javascript:|vbscript:|data:text\/html)/i;

function forbiddenUrl(value: string) {
  return FORBIDDEN_URL.test(value.replace(/[\u0000-\u0020]+/g, ""));
}

export function sanitizePublicationStylesheet(input: string) {
  let removedRemoteUrls = 0;
  const css = input
    .replace(/@import\s+[^;]+;?/gi, () => { removedRemoteUrls += 1; return ""; })
    .replace(/url\(([^)]*)\)/gi, (match, raw: string) => {
      const target = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!target.includes("\\") && !target.includes(":") && !target.startsWith("//") && !/[\u0000-\u0020]/.test(target)) return match;
      removedRemoteUrls += 1;
      return "none";
    });
  return { css, removedRemoteUrls };
}

export function sanitizePublicationDocument(input: string) {
  const { document } = parseHTML(input);
  const removed = { scripts: 0, activeElements: 0, eventAttributes: 0, remoteUrls: 0 };
  for (const node of [...document.querySelectorAll("script")]) { removed.scripts += 1; node.remove(); }
  for (const node of [...document.querySelectorAll(ACTIVE_ELEMENTS)]) { removed.activeElements += 1; node.remove(); }
  for (const node of [...document.querySelectorAll("meta[http-equiv]")]) {
    if (node.getAttribute("http-equiv")?.toLowerCase() === "refresh") { removed.activeElements += 1; node.remove(); }
  }
  for (const node of [...document.querySelectorAll("*")]) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) { node.removeAttribute(attribute.name); removed.eventAttributes += 1; continue; }
      const unsafe = name === "srcset"
        ? attribute.value.split(",").some((part) => forbiddenUrl(part.trim().split(/\s+/)[0] ?? ""))
        : URL_ATTRIBUTES.has(name) && forbiddenUrl(attribute.value);
      if (unsafe) { node.removeAttribute(attribute.name); removed.remoteUrls += 1; continue; }
      if (name === "style") {
        const result = sanitizePublicationStylesheet(attribute.value);
        node.setAttribute(attribute.name, result.css);
        removed.remoteUrls += result.removedRemoteUrls;
      }
    }
  }
  for (const node of [...document.querySelectorAll("style")]) {
    const result = sanitizePublicationStylesheet(node.textContent ?? "");
    node.textContent = result.css;
    removed.remoteUrls += result.removedRemoteUrls;
  }
  const html = document.toString().replace(/<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\b[^<>]*?)(?<!\/)>(?!\s*<\/\1>)/gi, "<$1$2/>");
  return { html, removed };
}
