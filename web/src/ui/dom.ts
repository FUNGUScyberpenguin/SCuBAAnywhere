type Child = Node | string | null | undefined | false;

/** Build an element. Text children are set as text, never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(name.replace(/^on/, ""), value);
    else if (typeof value === "boolean") { if (value) node.setAttribute(name, ""); }
    else node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.firstChild.remove();
}

/**
 * CISA writes the baselines in Markdown, so a requirement can arrive as
 * `A minimum of **two** ... SHALL be configured.` Only the emphasis markers get
 * in the way on one line of a table, so they are dropped and the rest is left
 * alone rather than half-rendered.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\\([-_*>])/g, "$1")
    .trim();
}

/** Escape for the standalone HTML export, which is built as a string. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
