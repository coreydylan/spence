/**
 * Tiny safe markdown → React renderer.
 *
 * Supports the subset chat actually needs:
 *   - paragraphs (blank-line separated)
 *   - bullet lists (`- ` or `* `)
 *   - numbered lists (`1. `)
 *   - inline `**bold**`, `*italic*`, `_italic_`, `` `code` ``
 *   - links `[text](https://example.com)` (only http/https/mailto schemes)
 *
 * No raw HTML pass-through. No images. No tables. No headings beyond `#`.
 * This is intentional — chat reply content stays bounded and safe.
 *
 * The renderer returns `React.ReactNode`, never a string with `dangerouslySet
 * InnerHTML`, so XSS is structurally impossible.
 */

import * as React from "react";

const SAFE_LINK_RE = /^(https?:|mailto:)/i;

type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "h"; level: 1 | 2 | 3; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !line.trim()) {
      i++;
      continue;
    }
    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({
        kind: "h",
        level: h[1].length as 1 | 2 | 3,
        text: h[2].trim(),
      });
      i++;
      continue;
    }
    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", items });
      continue;
    }
    // Paragraph: gather lines until blank
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ kind: "p", text: buf.join(" ") });
  }
  return out;
}

/**
 * Render inline-level markdown into React nodes. Handles `**bold**`,
 * `*italic*` / `_italic_`, `` `code` ``, and `[text](url)` links.
 *
 * The parser is a single-pass tokenizer; it matches the *first* opening
 * delimiter at each position and walks forward. Unmatched delimiters render
 * as literal characters.
 */
function renderInline(text: string, keyPrefix = ""): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  let buf = "";
  let k = 0;

  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // `code`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        out.push(
          <code
            key={`${keyPrefix}c${k++}`}
            className="font-mono text-[0.92em] bg-cream-deep dark:bg-ink-soft/30 px-1 py-0.5 rounded-[var(--radius-sm)]"
          >
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }

    // **bold**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        out.push(
          <strong key={`${keyPrefix}b${k++}`} className="font-semibold">
            {renderInline(text.slice(i + 2, end), `${keyPrefix}b${k}-`)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }

    // *italic* or _italic_
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        out.push(
          <em key={`${keyPrefix}i${k++}`} className="italic">
            {renderInline(text.slice(i + 1, end), `${keyPrefix}i${k}-`)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }

    // [text](url)
    if (ch === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          if (SAFE_LINK_RE.test(href)) {
            flush();
            out.push(
              <a
                key={`${keyPrefix}l${k++}`}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-terracotta underline underline-offset-2 hover:text-terracotta/80"
              >
                {renderInline(linkText, `${keyPrefix}l${k}-`)}
              </a>,
            );
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Render a markdown string as React. Safe by construction: no innerHTML,
 * unknown delimiters fall through as literal text, only http/https/mailto
 * links allowed.
 */
export function renderMarkdown(src: string): React.ReactElement {
  const blocks = parseBlocks(src);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h": {
            const sizes = { 1: "text-2xl", 2: "text-xl", 3: "text-lg" } as const;
            const Tag = (`h${b.level}` as "h1" | "h2" | "h3");
            return React.createElement(
              Tag,
              {
                key: i,
                className: `font-serif ${sizes[b.level]} text-ink dark:text-cream leading-tight`,
              },
              renderInline(b.text, `h${i}-`),
            );
          }
          case "ul":
            return (
              <ul key={i} className="list-disc pl-5 flex flex-col gap-1">
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `ul${i}-${j}-`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal pl-5 flex flex-col gap-1">
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `ol${i}-${j}-`)}</li>
                ))}
              </ol>
            );
          case "p":
            return (
              <p key={i} className="leading-relaxed">
                {renderInline(b.text, `p${i}-`)}
              </p>
            );
        }
      })}
    </>
  );
}
