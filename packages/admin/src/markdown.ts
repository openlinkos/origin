/**
 * A small Markdown renderer for what agents write, on the server. Session text is untrusted (any
 * device can push it), so the renderer never passes markup through: it only recognises structure,
 * and every piece of text it outputs, code and link targets included, goes through the escaping
 * `html` template. The markup comes from the renderer's own static strings alone.
 *
 * Supported: paragraphs (line breaks kept), headings, bold and italic, inline code, fenced code
 * blocks, bulleted and numbered lists (nested by indentation), blockquotes, thematic breaks, pipe
 * tables (a header, a delimiter row that sets each column's alignment, and rows, with inline markup
 * in the cells and `\|` for a pipe), and links to http and https URLs, written `[label](url)` or
 * bare, which open in a new tab with `rel="noopener noreferrer"` and show their URL. Anything else,
 * HTML included, stays text; a table whose header and delimiter row disagree is kept as written,
 * in monospace.
 */
import { type HtmlValue, html, type SafeHtml } from './html.js';

/** Lists and blockquotes nest at most this deep; deeper lines are paragraphs. */
const MAX_DEPTH = 4;
/** Emphasis nests at most this deep. */
const MAX_INLINE_DEPTH = 3;
/** A block longer than this is shown as plain text: its inline markup is not looked for. */
const INLINE_MAX = 20_000;
/** At most this many characters between markers of inline markup. */
const SPAN_MAX = 2_000;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-*+])(?:[ \t]+(.*))?$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])(?:[ \t]+(.*))?$/;
const LANG = /^[\w+#.-]{1,32}$/;

const blank = (line: string) => line.trim() === '';
const indentOf = (line: string) => line.length - line.trimStart().length;

/** Render Markdown text as safe markup, wrapped in `.admin-md`. */
export function markdown(text: string): SafeHtml {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, '    '));
  return html`<div class="admin-md">${blocks(lines, 0)}</div>`;
}

interface ListItemStart {
  indent: number;
  /** Where the item's content starts: lines indented this far continue it. */
  contentIndent: number;
  ordered: boolean;
  /** The bullet character, or the delimiter of a number. */
  marker: string;
  number: number;
  content: string;
}

function listItem(line: string): ListItemStart | null {
  const b = BULLET.exec(line);
  if (b) {
    const indent = b[1]?.length ?? 0;
    const content = b[3] ?? '';
    return {
      indent,
      contentIndent: content === '' ? indent + 2 : line.indexOf(content, indent + 1),
      ordered: false,
      marker: b[2] ?? '-',
      number: 1,
      content,
    };
  }
  const o = ORDERED.exec(line);
  if (o) {
    const indent = o[1]?.length ?? 0;
    const content = o[4] ?? '';
    const head = (o[2] ?? '').length + 1;
    return {
      indent,
      contentIndent: content === '' ? indent + head + 1 : line.indexOf(content, indent + head),
      ordered: true,
      marker: o[3] ?? '.',
      number: Number(o[2]),
      content,
    };
  }
  return null;
}

/** Whether a line starts a block other than a paragraph, and so ends the paragraph before it. */
function startsBlock(line: string, depth: number): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line)) return true;
  if (depth >= MAX_DEPTH) return false;
  return QUOTE.test(line) || listItem(line) !== null;
}

function blocks(lines: string[], depth: number): SafeHtml[] {
  const out: SafeHtml[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? '```';
      const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i++; // the closing fence, or the end
      const lang = fence[2] ?? '';
      out.push(
        html`<div class="ol-code admin-md-code">${LANG.test(lang) ? html`<div class="ol-code-label">${lang}</div>` : ''}<pre><code>${body.join('\n')}</code></pre></div>`,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const content = inline(heading[2] ?? '', 0, true);
      out.push(
        level === 1
          ? html`<h4 class="admin-md-h">${content}</h4>`
          : level === 2
            ? html`<h5 class="admin-md-h">${content}</h5>`
            : html`<h6 class="admin-md-h">${content}</h6>`,
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(html`<hr>`);
      i++;
      continue;
    }

    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (QUOTE.test(l)) inner.push(l.replace(QUOTE, ''));
        else if (
          !blank(l) &&
          inner.length > 0 &&
          !blank(inner.at(-1) ?? '') &&
          !startsBlock(l, depth)
        )
          inner.push(l); // a lazy continuation of the quoted paragraph
        else break;
        i++;
      }
      out.push(html`<blockquote>${blocks(inner, depth + 1)}</blockquote>`);
      continue;
    }

    const first = depth < MAX_DEPTH ? listItem(line) : null;
    if (first) {
      const r = list(lines, i, first, depth);
      out.push(r.html);
      i = r.next;
      continue;
    }

    const rule = line.includes('|') ? delimiterRow(lines[i + 1] ?? '') : null;
    if (rule) {
      const header = tableCells(line);
      if (header.length !== rule.length) {
        // The header and the delimiter row disagree: no table, the lines stay as written.
        const rows: string[] = [];
        while (i < lines.length && !blank(lines[i] ?? '') && (lines[i] ?? '').includes('|')) {
          rows.push(lines[i++] ?? '');
        }
        out.push(html`<pre class="admin-md-text">${rows.join('\n')}</pre>`);
        continue;
      }
      const body: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = lines[i] ?? '';
        if (blank(row) || !row.includes('|') || startsBlock(row, depth)) break;
        body.push(tableCells(row));
        i++;
      }
      out.push(table(header, rule, body));
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i] ?? '') && !startsBlock(lines[i] ?? '', depth)) {
      const next = lines[i] ?? '';
      // A table's header ends the paragraph before it.
      if (next.includes('|') && delimiterRow(lines[i + 1] ?? '')) break;
      para.push(next.trim());
      i++;
    }
    out.push(html`<p>${inline(para.join('\n'), 0, true)}</p>`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tables (GitHub's pipe tables)

type Align = 'left' | 'center' | 'right' | null;

/** A table cell longer than this many characters wraps; shorter ones keep to one line. */
const WRAP_CELL = 40;

/**
 * The cells of a table row: split at every `|` not escaped as `\|`, which stands for a pipe in the
 * cell (code spans included, as on GitHub), without the leading and trailing pipe, trimmed. Other
 * escapes are left to the cell's inline markup.
 */
export function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The alignment of each column, if the line is a table's delimiter row (`| :--- | ---: |`). */
function delimiterRow(line: string): Align[] | null {
  if (!line.includes('|') || !/^[\s|:-]+$/.test(line)) return null;
  const cells = tableCells(line);
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

/** A table: a header row and its body, as many cells per row as the header (ragged rows fit). */
function table(header: string[], align: Align[], body: string[][]): SafeHtml {
  const cell = (tag: 'th' | 'td', text: string, a: Align) => {
    const content = inline(text, 0, true);
    // Cells keep to one line, so a wide table scrolls; only long text wraps.
    const names = [a ? `admin-md-${a}` : '', text.length > WRAP_CELL ? 'admin-md-wrap' : '']
      .filter(Boolean)
      .join(' ');
    const cls = names ? html` class="${names}"` : '';
    return tag === 'th' ? html`<th${cls}>${content}</th>` : html`<td${cls}>${content}</td>`;
  };
  return html`<div class="admin-md-table"><table><thead><tr>${header.map((h, k) => cell('th', h, align[k] ?? null))}</tr></thead>${
    body.length === 0
      ? ''
      : html`<tbody>${body.map(
          (row) =>
            html`<tr>${header.map((_, k) => cell('td', row[k] ?? '', align[k] ?? null))}</tr>`,
        )}</tbody>`
  }</table></div>`;
}

function list(
  lines: string[],
  start: number,
  first: ListItemStart,
  depth: number,
): { html: SafeHtml; next: number } {
  const sibling = (s: ListItemStart | null): s is ListItemStart =>
    s !== null &&
    s.ordered === first.ordered &&
    s.marker === first.marker &&
    s.indent < first.contentIndent;
  const items: string[][] = [];
  let item: ListItemStart = first;
  let content: string[] = [first.content];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (blank(line)) {
      // A blank line continues the list if the item, or another one, goes on after it.
      let j = i + 1;
      while (j < lines.length && blank(lines[j] ?? '')) j++;
      const after = lines[j] ?? '';
      if (j < lines.length && (indentOf(after) >= item.contentIndent || sibling(listItem(after)))) {
        content.push('');
        i++;
        continue;
      }
      break;
    }
    const next = listItem(line);
    if (sibling(next)) {
      items.push(content);
      item = next;
      content = [next.content];
      i++;
      continue;
    }
    if (indentOf(line) >= item.contentIndent) {
      content.push(line.slice(item.contentIndent));
      i++;
      continue;
    }
    if (startsBlock(line, depth) || blank(content.at(-1) ?? '')) break;
    content.push(line.trim()); // a lazy continuation of the item's paragraph
    i++;
  }
  items.push(content);
  const lis = items.map((c) => html`<li>${blocks(c, depth + 1)}</li>`);
  const markup = !first.ordered
    ? html`<ul>${lis}</ul>`
    : first.number === 1
      ? html`<ol>${lis}</ol>`
      : html`<ol start="${first.number}">${lis}</ol>`;
  return { html: markup, next: i };
}

// ---------------------------------------------------------------------------------------------
// Inline markup

const CODE = new RegExp(`(\`+)([^\\n]{1,${SPAN_MAX}}?)(?<!\`)\\1(?!\`)`, 'y');
const LINK = new RegExp(
  `\\[([^\\[\\]\\n]{1,500})\\]\\((https?:\\/\\/[^\\s()]{1,${SPAN_MAX}})(?:[ \\t]+"[^"\\n]{0,200}")?\\)`,
  'iy',
);
const AUTOLINK = new RegExp(
  `https?:\\/\\/[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=%]{1,${SPAN_MAX}}`,
  'iy',
);
const BOTH_STAR = new RegExp(`\\*\\*\\*(?=\\S)([\\s\\S]{0,${SPAN_MAX}}?\\S)\\*\\*\\*`, 'y');
const STRONG_STAR = new RegExp(`\\*\\*(?=\\S)([\\s\\S]{0,${SPAN_MAX}}?\\S)\\*\\*`, 'y');
const STRONG_UNDER = new RegExp(
  `__(?=\\S)([\\s\\S]{0,${SPAN_MAX}}?\\S)__(?![\\p{L}\\p{N}_])`,
  'uy',
);
const EM_STAR = new RegExp(`\\*(?=[^\\s*])([\\s\\S]{0,${SPAN_MAX}}?[^\\s*])\\*(?!\\*)`, 'y');
const EM_UNDER = new RegExp(
  `_(?=[^\\s_])([\\s\\S]{0,${SPAN_MAX}}?[^\\s_])_(?![\\p{L}\\p{N}_])`,
  'uy',
);
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}_]/u;

function at(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(src);
}

/** An http or https URL, as the browser will read it; null for anything else. */
export function safeUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/** A bare URL ends before the punctuation that follows it, and before an unopened bracket. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1) ?? '';
    if (/[.,;:!?'*]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
    else if (last === ']' && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
    else return url;
  }
}

function count(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}

function link(href: string, label: HtmlValue, shown: string | null): SafeHtml {
  return html`<a class="admin-md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>${
    shown === null ? '' : html` <span class="admin-md-url">${shown}</span>`
  }`;
}

/** Text with its line breaks kept. */
function textRun(text: string): HtmlValue[] {
  const parts = text.split('\n');
  return parts.map((p, i) => (i === 0 ? p : html`<br>${p}`));
}

/**
 * Inline markup of one block. Text between the markup is collected as is and escaped when it is
 * output; `links` is false inside a link's label.
 */
function inline(src: string, depth: number, links: boolean): HtmlValue[] {
  if (src.length > INLINE_MAX) return textRun(src);
  const out: HtmlValue[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') out.push(...textRun(text));
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === '\\' && ESCAPABLE.test(src[i + 1] ?? '')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const m = at(CODE, src, i);
      if (m) {
        flush();
        const code = m[2] ?? '';
        // One space on each side is padding, so that code can start or end with a backtick.
        out.push(
          html`<code>${/^ .* $/.test(code) && code.trim() !== '' ? code.slice(1, -1) : code}</code>`,
        );
        i += m[0].length;
      } else {
        const run = /^`+/.exec(src.slice(i))?.[0] ?? '`';
        text += run;
        i += run.length;
      }
      continue;
    }
    if (links && c === '[') {
      const m = at(LINK, src, i);
      const href = m ? safeUrl(m[2] ?? '') : null;
      if (m && href) {
        flush();
        const label = m[1] ?? '';
        const url = m[2] ?? '';
        out.push(link(href, inline(label, depth + 1, false), label.trim() === url ? null : url));
        i += m[0].length;
        continue;
      }
    }
    if (links && (c === 'h' || c === 'H') && !WORD.test(src[i - 1] ?? '')) {
      const m = at(AUTOLINK, src, i);
      if (m) {
        const url = trimUrl(m[0]);
        const href = safeUrl(url);
        if (href && /^https?:\/\/[^/?#]/i.test(url)) {
          flush();
          out.push(link(href, url, null));
          i += url.length;
          continue;
        }
      }
    }
    if ((c === '*' || c === '_') && depth < MAX_INLINE_DEPTH) {
      const under = c === '_';
      // Underscores mark emphasis only at the edges of words, never inside snake_case names.
      if (!under || !WORD.test(src[i - 1] ?? '')) {
        const both = under ? null : at(BOTH_STAR, src, i);
        if (both) {
          flush();
          out.push(html`<em><strong>${inline(both[1] ?? '', depth + 1, links)}</strong></em>`);
          i += both[0].length;
          continue;
        }
        const strong = at(under ? STRONG_UNDER : STRONG_STAR, src, i);
        if (strong) {
          flush();
          out.push(html`<strong>${inline(strong[1] ?? '', depth + 1, links)}</strong>`);
          i += strong[0].length;
          continue;
        }
        const em = at(under ? EM_UNDER : EM_STAR, src, i);
        if (em) {
          flush();
          out.push(html`<em>${inline(em[1] ?? '', depth + 1, links)}</em>`);
          i += em[0].length;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}
