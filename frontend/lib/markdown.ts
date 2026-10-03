import { Marked, type Tokens } from "marked";
import { esc, highlightLines } from "./render";

/**
 * Docs Markdown → HTML, on the server (at build time for public docs).
 *
 * Syntax highlighting reuses lib/render.js — the same highlighter as the
 * explorer's source previews — so code looks the same everywhere. render.js's
 * own Markdown renderer is not used here: it deliberately drops relative links
 * (it renders untrusted READMEs), and docs need them.
 *
 * Input is our own content, never user input.
 */

const FAMILY: Record<string, string> = {
  bash: "sh", sh: "sh", shell: "sh", console: "sh", dockerfile: "sh",
  python: "py", py: "py",
  js: "js", javascript: "js", ts: "js", typescript: "js", tsx: "js", jsx: "js",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  css: "css", html: "html",
};

export type TocItem = { id: string; text: string; depth: 2 | 3 };

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z#0-9]+;/g, "")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

const stripTags = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** A highlighted code block with a copy button (wired up by <CopyCode />). */
export function codeHtml(code: string, lang = ""): string {
  const family = FAMILY[lang.toLowerCase()] ?? "";
  const lines = highlightLines(code.replace(/\n$/, ""), family);
  return (
    `<div class="code"><div class="code-head"><span>${esc(lang || "text")}</span>` +
    `<button type="button" class="copy" data-copy>Copy</button></div>` +
    `<pre><code>${lines.join("\n")}</code></pre></div>`
  );
}

export function renderDoc(md: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const text = stripTags(inner);
        let id = slugify(text);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (token.depth === 2 || token.depth === 3) toc.push({ id, text, depth: token.depth });
        const anchor =
          token.depth <= 3
            ? `<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>`
            : "";
        return `<h${token.depth} id="${id}">${anchor}${inner}</h${token.depth}>\n`;
      },
      code(token: Tokens.Code) {
        return codeHtml(token.text, (token.lang ?? "").split(/\s/)[0]);
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const href = esc(token.href);
        const external = /^https?:\/\//.test(token.href);
        return external
          ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${inner}</a>`
          : `<a href="${href}">${inner}</a>`;
      },
    },
  });
  const html = (marked.parse(md) as string)
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
  return { html, toc };
}
