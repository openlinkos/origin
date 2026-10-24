import { describe, expect, it } from 'vitest';
import { markdown, safeUrl } from '../src/markdown.js';

const md = (text: string) => markdown(text).value;
/** The rendered markup, without the wrapper. */
const inner = (text: string) =>
  md(text).replace(/^<div class="ol-prose ol-prose-sm">|<\/div>$/g, '');

/** The tags and attributes the renderer may write; anything else is a failure. */
const TAGS = new Set([
  'div',
  'p',
  'br',
  'strong',
  'em',
  'code',
  'pre',
  'a',
  'span',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const ATTRIBUTES = new Set(['class', 'href', 'target', 'rel', 'start']);
/** The classes the renderer may write: the design system's prose, code, and table cells. */
const CLASSES = new Set([
  'ol-prose',
  'ol-prose-sm',
  'ol-code',
  'ol-code-label',
  'ol-prose-table',
  'ol-align-start',
  'ol-align-center',
  'ol-align-end',
  'ol-cell-wrap',
  'admin-md-url',
]);

/** Every tag of the output is one the renderer writes, with its attributes and classes only. */
function markupProblems(out: string): string[] {
  const problems: string[] = [];
  for (const [tag, name = '', attrs = ''] of out.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    if (!TAGS.has(name.toLowerCase())) problems.push(`tag ${tag}`);
    const rest = attrs.replace(/\s([a-z]+)="([^"]*)"/g, (_m, a: string, v: string) => {
      if (!ATTRIBUTES.has(a)) problems.push(`attribute ${a} in ${tag}`);
      if (a === 'class') {
        for (const c of v.split(' ')) if (!CLASSES.has(c)) problems.push(`class ${c} in ${tag}`);
      }
      if (a === 'href' && !/^https?:\/\//.test(v)) problems.push(`href ${v}`);
      if (a === 'target' && v !== '_blank') problems.push(`target ${v}`);
      if (a === 'rel' && v !== 'noopener noreferrer') problems.push(`rel ${v}`);
      return '';
    });
    if (rest.replace(/\/$/, '').trim() !== '') problems.push(`stray markup in ${tag}`);
  }
  // Outside tags, no character can start markup or end an attribute.
  const text = out.replace(/<[^>]*>/g, '');
  if (/[<>"]/.test(text)) problems.push(`raw markup in text: ${text}`);
  return problems;
}

describe('markdown', () => {
  it('renders paragraphs, keeping line breaks, and escapes their text', () => {
    expect(inner('One line\nand the next\n\nA second paragraph & more')).toBe(
      '<p>One line<br>and the next</p><p>A second paragraph &amp; more</p>',
    );
  });

  it('renders headings below the page headings', () => {
    expect(inner('# Title\n## Part\n### Detail\n#### Deeper ##')).toBe(
      '<h4>Title</h4><h5>Part</h5><h6>Detail</h6><h6>Deeper</h6>',
    );
    expect(inner('#hashtag')).toBe('<p>#hashtag</p>');
  });

  it('renders bold, italic, and inline code, but not inside words or code', () => {
    expect(inner('**bold** and __bold__, *it* and _it_')).toBe(
      '<p><strong>bold</strong> and <strong>bold</strong>, <em>it</em> and <em>it</em></p>',
    );
    expect(inner('***both***')).toBe('<p><em><strong>both</strong></em></p>');
    expect(inner('snake_case_name and file_name_here')).toBe(
      '<p>snake_case_name and file_name_here</p>',
    );
    expect(inner('Run `pnpm test` with ``a ` tick`` and `**not bold**`')).toBe(
      '<p>Run <code>pnpm test</code> with <code>a &#96; tick</code> and <code>**not bold**</code></p>',
    );
    expect(inner('an \\*escaped\\* star, a lone * and ** pair')).toBe(
      '<p>an *escaped* star, a lone * and ** pair</p>',
    );
    expect(inner('unclosed `code and **bold')).toBe('<p>unclosed &#96;code and **bold</p>');
  });

  it('renders fenced code blocks with their language, as text', () => {
    expect(inner('```ts\nconst a = 1 < 2;\n\n**x**\n```')).toBe(
      '<div class="ol-code"><div class="ol-code-label">ts</div><pre><code>const a = 1 &lt; 2;\n\n**x**</code></pre></div>',
    );
    expect(inner('~~~~\nunclosed\n~~~')).toBe(
      '<div class="ol-code"><pre><code>unclosed\n~~~</code></pre></div>',
    );
    // An info string that is not a plain language name is not shown.
    expect(inner('``` x" onclick="y\nz\n```')).toBe(
      '<div class="ol-code"><pre><code>z</code></pre></div>',
    );
  });

  it('renders bulleted and numbered lists, nested by indentation', () => {
    expect(inner('- one\n- two\n  - nested\n- three')).toBe(
      '<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li><li><p>three</p></li></ul>',
    );
    expect(inner('3. third\n4. fourth\n\n* star')).toBe(
      '<ol start="3"><li><p>third</p></li><li><p>fourth</p></li></ol><ul><li><p>star</p></li></ul>',
    );
    expect(inner('1) a\n   continued\n2) b')).toBe(
      '<ol><li><p>a<br>continued</p></li><li><p>b</p></li></ol>',
    );
    expect(inner('Text\n- item')).toBe('<p>Text</p><ul><li><p>item</p></li></ul>');
  });

  it('renders blockquotes and thematic breaks', () => {
    expect(inner('> quoted **text**\nlazily continued\n\n---')).toBe(
      '<blockquote><p>quoted <strong>text</strong><br>lazily continued</p></blockquote><hr>',
    );
    expect(inner('> > nested')).toBe(
      '<blockquote><blockquote><p>nested</p></blockquote></blockquote>',
    );
  });

  it('renders links to http and https only, in a new tab, with their URL shown', () => {
    expect(inner('See [the docs](https://example.com/a?b=1&c=2).')).toBe(
      '<p>See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the docs</a> <span class="admin-md-url">https://example.com/a?b=1&amp;c=2</span>.</p>',
    );
    expect(inner('Bare https://example.com/x_y, then (http://a.example/b).')).toBe(
      '<p>Bare <a href="https://example.com/x_y" target="_blank" rel="noopener noreferrer">https://example.com/x_y</a>, then (<a href="http://a.example/b" target="_blank" rel="noopener noreferrer">http://a.example/b</a>).</p>',
    );
    expect(inner('[same](https://example.com/)')).toBe(
      '<p><a href="https://example.com/" target="_blank" rel="noopener noreferrer">same</a> <span class="admin-md-url">https://example.com/</span></p>',
    );
    expect(inner('见 https://example.com/页面。')).toContain('href="https://example.com/"');
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://x.example',
      'vbscript:x',
    ]) {
      expect(inner(`[x](${url})`)).not.toContain('<a');
      expect(safeUrl(url)).toBeNull();
    }
  });

  it('renders pipe tables, aligned by their delimiter row, with inline markup in the cells', () => {
    expect(
      inner(
        '| Step | Count | Note |\n|:---|---:|:-:|\n| **build** | 12 | `ok` |\n| test | 3 | — |',
      ),
    ).toBe(
      '<div class="ol-prose-table"><table><thead><tr><th class="ol-align-start">Step</th><th class="ol-align-end">Count</th><th class="ol-align-center">Note</th></tr></thead>' +
        '<tbody><tr><td class="ol-align-start"><strong>build</strong></td><td class="ol-align-end">12</td><td class="ol-align-center"><code>ok</code></td></tr>' +
        '<tr><td class="ol-align-start">test</td><td class="ol-align-end">3</td><td class="ol-align-center">—</td></tr></tbody></table></div>',
    );
    // Long cells may wrap; the others keep to one line.
    expect(inner(`| a | b |\n|---|--:|\n| ${'word '.repeat(10)}| 1 |`)).toContain(
      `<td class="ol-cell-wrap">${'word '.repeat(10).trim()}</td><td class="ol-align-end">1</td>`,
    );
    // Without outer pipes, and without a body.
    expect(inner('a | b\n--- | ---')).toBe(
      '<div class="ol-prose-table"><table><thead><tr><th>a</th><th>b</th></tr></thead></table></div>',
    );
    // A single column, and a table straight after a paragraph's line, as on GitHub.
    expect(inner('Results:\n| only |\n| --- |\n| one |')).toBe(
      '<p>Results:</p><div class="ol-prose-table"><table><thead><tr><th>only</th></tr></thead><tbody><tr><td>one</td></tr></tbody></table></div>',
    );
  });

  it('reads \\| as a pipe inside cells, code included, and fits ragged rows to the header', () => {
    expect(inner('| Expr | Means |\n|---|---|\n| `a \\| b` | a or b \\| c |')).toBe(
      '<div class="ol-prose-table"><table><thead><tr><th>Expr</th><th>Means</th></tr></thead><tbody><tr><td><code>a | b</code></td><td>a or b | c</td></tr></tbody></table></div>',
    );
    const ragged = inner('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |');
    expect(ragged).toContain('<tr><td>1</td><td></td><td></td></tr>');
    expect(ragged).toContain('<tr><td>1</td><td>2</td><td>3</td></tr>');
    expect(ragged).not.toContain('4');
    // The table ends at a blank line, or at a line that starts another block.
    expect(inner('| a |\n|---|\n| 1 |\n\nAfter')).toMatch(/<\/table><\/div><p>After<\/p>$/);
    expect(inner('| a |\n|---|\n| 1 |\n- item')).toMatch(
      /<\/table><\/div><ul><li><p>item<\/p><\/li><\/ul>$/,
    );
  });

  it('keeps malformed tables and HTML as text', () => {
    // The header and the delimiter row disagree.
    expect(inner('| a | b |\n|---|\n| <i>1</i> | 2 |')).toBe(
      '<pre>| a | b |\n|---|\n| &lt;i&gt;1&lt;/i&gt; | 2 |</pre>',
    );
    // No delimiter row, or one with something other than dashes and colons.
    expect(inner('| a | b |\n| c | d |')).toBe('<p>| a | b |<br>| c | d |</p>');
    expect(inner('| a | b |\n|--x|---|')).toBe('<p>| a | b |<br>|--x|---|</p>');
    expect(inner('<details open><summary>x</summary></details>')).toBe(
      '<p>&lt;details open&gt;&lt;summary&gt;x&lt;/summary&gt;&lt;/details&gt;</p>',
    );
  });

  it("writes the design system's prose, with its own classes only", () => {
    const out = md(
      [
        '# Title',
        'Text with `code`, **bold**, and [a link](https://example.com/a).',
        '- one\n  1. nested',
        '> quoted',
        '---',
        '```sh\nls\n```',
        `| a | b | c |\n|:-|:-:|-:|\n| ${'long '.repeat(10)} | x | 1 |`,
        '| a | b |\n|---|\n| 1 | 2 |',
      ].join('\n\n'),
    );
    expect(out.startsWith('<div class="ol-prose ol-prose-sm"><h4>Title</h4>')).toBe(true);
    for (const c of ['ol-code-label', 'ol-align-start', 'ol-align-center', 'ol-align-end'])
      expect(out).toContain(`class="${c}"`);
    expect(out).toContain('<td class="ol-align-start ol-cell-wrap">');
    expect(out).toContain('<pre>| a | b |');
    expect(markupProblems(out)).toEqual([]);
    // The check itself: a class outside the list is a problem.
    expect(markupProblems('<p class="ol-prose admin-md">x</p>')).toEqual([
      'class admin-md in <p class="ol-prose admin-md">',
    ]);
  });

  it('never lets hostile text become markup', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '"><script>alert(1)</script>',
      "'><img src=x onerror=alert(1)>",
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](https://example.com" onmouseover="alert(1))',
      '[x](https://example.com/"><script>alert(1)</script>)',
      '[<img src=x onerror=alert(1)>](https://example.com)',
      'https://example.com/"onmouseover="alert(1)',
      'https://example.com/<script>alert(1)</script>',
      'http://"><img src=x onerror=alert(1)>',
      '`<script>alert(1)</script>`',
      '```html" onload="alert(1)\n<script>alert(1)</script>\n```',
      '# <script>alert(1)</script>',
      '- <a href="javascript:alert(1)">x</a>',
      '> <iframe src="https://evil.example"></iframe>',
      '**<b onmouseover=alert(1)>x</b>**',
      '&lt;script&gt;alert(1)&lt;/script&gt;',
      '&#60;script&#62; &#x3C;img src=x onerror=alert(1)&#x3E;',
      '[a](https://example.com/‮)',
      `${'*'.repeat(5000)}x${'_'.repeat(5000)}`,
      `${'[a]('.repeat(3000)}https://x.example`,
      `${'`'.repeat(4000)}`,
      // Tables: hostile cells, headers, alignments, and escapes.
      '| <script>alert(1)</script> | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |',
      '| a" onmouseover="alert(1) | b |\n|:-:|-:|\n| `<svg onload=alert(1)>` \\| x | **<b>y</b>** |',
      '| [ok](https://example.com/"><script>) | c |\n|---|---|\n| </td></tr></table><script>alert(1)</script> | d |',
      '| a |\n|:--:" onclick="x|\n| b |',
      `| ${'|'.repeat(3000)} |\n|${'---|'.repeat(3)}\n| x |`,
      `| a |\n|---|\n${'| <i>x</i> \\| y |\n'.repeat(2000)}`,
    ];
    for (const text of hostile) {
      const out = md(text);
      expect(markupProblems(out), text.slice(0, 60)).toEqual([]);
      // Event handlers and scripts appear only as escaped text, never in a tag.
      const tags = (out.match(/<[^>]*>/g) ?? []).join('');
      expect(tags).not.toMatch(
        /<(script|img|svg|iframe|details)\b|\son[a-z]+=|href="(?!https?:\/\/)/i,
      );
      expect(out).not.toMatch(/<(script|img|svg|iframe)/i);
    }
    // Hostile cells are tables still, with every cell escaped.
    const cells = md(hostile[hostile.length - 6] ?? '');
    expect(cells).toContain('<th>&lt;script&gt;alert(1)&lt;/script&gt;</th><th>b</th>');
    expect(cells).toContain(
      '<td>&lt;img src=x onerror=alert(1)&gt;</td><td>[x](javascript:alert(1))</td>',
    );
    expect(md(hostile[hostile.length - 5] ?? '')).toContain(
      '<th class="ol-align-center">a&quot; onmouseover=&quot;alert(1)</th>',
    );
    // Entities in the text are shown as written, never decoded into markup.
    expect(inner('&lt;b&gt;')).toBe('<p>&amp;lt;b&amp;gt;</p>');
  });

  it('stays fast on long and pathological text', () => {
    const started = Date.now();
    md(`${'**a '.repeat(20_000)}\n${'- x\n'.repeat(5000)}${'> '.repeat(100)}deep`);
    md('_'.repeat(50_000));
    md(`${'`a'.repeat(30_000)}`);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
