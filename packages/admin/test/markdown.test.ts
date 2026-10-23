import { describe, expect, it } from 'vitest';
import { markdown, safeUrl } from '../src/markdown.js';

const md = (text: string) => markdown(text).value;
/** The rendered markup, without the wrapper. */
const inner = (text: string) => md(text).replace(/^<div class="admin-md">|<\/div>$/g, '');

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
]);
const ATTRIBUTES = new Set(['class', 'href', 'target', 'rel', 'start']);

/** Every tag of the output is one the renderer writes, with its attributes only. */
function markupProblems(out: string): string[] {
  const problems: string[] = [];
  for (const [tag, name = '', attrs = ''] of out.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    if (!TAGS.has(name.toLowerCase())) problems.push(`tag ${tag}`);
    const rest = attrs.replace(/\s([a-z]+)="([^"]*)"/g, (_m, a: string, v: string) => {
      if (!ATTRIBUTES.has(a)) problems.push(`attribute ${a} in ${tag}`);
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
      '<h4 class="admin-md-h">Title</h4><h5 class="admin-md-h">Part</h5><h6 class="admin-md-h">Detail</h6><h6 class="admin-md-h">Deeper</h6>',
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
      '<div class="ol-code admin-md-code"><div class="ol-code-label">ts</div><pre><code>const a = 1 &lt; 2;\n\n**x**</code></pre></div>',
    );
    expect(inner('~~~~\nunclosed\n~~~')).toBe(
      '<div class="ol-code admin-md-code"><pre><code>unclosed\n~~~</code></pre></div>',
    );
    // An info string that is not a plain language name is not shown.
    expect(inner('``` x" onclick="y\nz\n```')).toBe(
      '<div class="ol-code admin-md-code"><pre><code>z</code></pre></div>',
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
      '<p>See <a class="admin-md-link" href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the docs</a> <span class="admin-md-url">https://example.com/a?b=1&amp;c=2</span>.</p>',
    );
    expect(inner('Bare https://example.com/x_y, then (http://a.example/b).')).toBe(
      '<p>Bare <a class="admin-md-link" href="https://example.com/x_y" target="_blank" rel="noopener noreferrer">https://example.com/x_y</a>, then (<a class="admin-md-link" href="http://a.example/b" target="_blank" rel="noopener noreferrer">http://a.example/b</a>).</p>',
    );
    expect(inner('[same](https://example.com/)')).toBe(
      '<p><a class="admin-md-link" href="https://example.com/" target="_blank" rel="noopener noreferrer">same</a> <span class="admin-md-url">https://example.com/</span></p>',
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

  it('keeps tables and HTML as text', () => {
    expect(inner('| a | b |\n|---|---|\n| <i>1</i> | 2 |')).toBe(
      '<pre class="admin-md-text">| a | b |\n|---|---|\n| &lt;i&gt;1&lt;/i&gt; | 2 |</pre>',
    );
    expect(inner('<details open><summary>x</summary></details>')).toBe(
      '<p>&lt;details open&gt;&lt;summary&gt;x&lt;/summary&gt;&lt;/details&gt;</p>',
    );
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
