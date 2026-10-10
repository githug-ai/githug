/**
 * Markdown → safe HTML, with no Node-only dependencies (runs on Workers too).
 *
 * XSS strategy: markdown rendered by marked is safe *as long as raw HTML can't pass
 * through*. So we drop raw HTML tokens entirely and allow only safe link protocols.
 * The only HTML in the output is marked's own generated tags (p, strong, table, a…).
 */
import { Marked, type Tokens } from "marked";

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function safeHref(href: string): string | null {
  const u = (href || "").trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (u.startsWith("/") || u.startsWith("#")) return u;
  return null; // drop javascript:, data:, etc.
}

const md = new Marked({ gfm: true });
md.use({
  renderer: {
    html: () => "", // drop raw HTML blocks/inline — the core XSS defense
    image: () => "", // drop images (avoid tracking pixels / SSRF surprises)
    link(this: any, { href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener nofollow">${text}</a>`;
    },
  },
});

export function markdownToSafeHtml(markdown: string): string {
  return md.parse(markdown, { async: false }) as string;
}

/** Plain-text excerpt for meta descriptions (strips the already-safe HTML). */
export function plainText(markdown: string, max = 160): string {
  const text = markdownToSafeHtml(markdown)
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
