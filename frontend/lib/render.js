/**
 * Markdown rendering and syntax highlighting for the preview pane.
 *
 * Lifted verbatim from visualizer/index.html, which is where this logic was
 * written and tested: everything is escaped before any markup is added, only
 * http(s)/mailto links become clickable, and images render as labels rather
 * than <img> so a README's badges never make the page fetch anything. Kept as
 * plain JavaScript so it stays byte-identical to the version under test.
 */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Code rendering ──────────────────────────────────────────────────────────
// A small tokenizer rather than a highlighting library: it keeps the page
// self-contained (no extra CDN fetch) and a preview pane does not need more.

const LANG_FAMILY = {
  py: 'py', pyi: 'py', pyw: 'py',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js',
  json: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', jinja: 'html', jinja2: 'html', j2: 'html', vue: 'html', svg: 'html',
  yml: 'yaml', yaml: 'yaml',
  sh: 'sh', bash: 'sh', zsh: 'sh', toml: 'sh', ini: 'sh', cfg: 'sh', conf: 'sh',
};

const KEYWORDS = {
  py: 'def|class|return|import|from|as|if|elif|else|for|while|try|except|finally|with|pass|raise|yield|lambda|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self|cls|match|case',
  js: 'function|class|const|let|var|return|import|from|export|default|if|else|for|while|do|try|catch|finally|switch|case|break|continue|new|this|typeof|instanceof|await|async|yield|null|undefined|true|false|extends|super|of|in|delete|void|interface|type|enum|implements|public|private|protected|readonly|static|throw|as',
  json: 'true|false|null',
  css: 'important|media|import|keyframes|supports|charset|font-face',
  html: '',
  yaml: 'true|false|null|yes|no|on|off',
  sh: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|FROM|RUN|CMD|COPY|ADD|ENV|WORKDIR|EXPOSE|ENTRYPOINT|VOLUME|ARG|USER|HEALTHCHECK',
};

const COMMENTS = {
  py: '#[^\\n]*',
  js: '//[^\\n]*|/\\*[\\s\\S]*?\\*/',
  json: '',
  css: '/\\*[\\s\\S]*?\\*/',
  html: '<!--[\\s\\S]*?-->',
  yaml: '#[^\\n]*',
  sh: '#[^\\n]*',
};

// Triple-quoted forms come first so a docstring is one token, not three.
const STRINGS = {
  py: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'',
  js: '`(?:[^`\\\\]|\\\\.)*`|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'',
  json: '"(?:[^"\\\\\\n]|\\\\.)*"',
  css: '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'',
  html: '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'',
  yaml: '"(?:[^"\\\\\\n]|\\\\.)*"|\'[^\'\\n]*\'',
  sh: '"(?:[^"\\\\\\n]|\\\\.)*"|\'[^\'\\n]*\'',
};

const _reCache = {};
function langRegex(family) {
  if (_reCache[family]) return _reCache[family];
  const parts = [];
  if (COMMENTS[family]) parts.push(`(?<comment>${COMMENTS[family]})`);
  if (STRINGS[family]) parts.push(`(?<string>${STRINGS[family]})`);
  parts.push('(?<def>(?<=\\b(?:def|class|function|interface)\\s+)[A-Za-z_$][\\w$]*)');
  if (KEYWORDS[family]) parts.push(`(?<keyword>\\b(?:${KEYWORDS[family]})\\b)`);
  parts.push('(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)');
  return (_reCache[family] = new RegExp(parts.join('|'), 'g'));
}

function langOf(filePath) {
  const base = String(filePath || '').split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'sh';
  if (base.startsWith('.env')) return 'sh';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return LANG_FAMILY[ext] || '';
}

// Tokenize the whole text rather than line by line, so a multi-line string or
// block comment stays one token; tokens are then split across line boundaries.
function highlightLines(code, family) {
  const lines = [[]];
  const push = (text, type) => {
    const parts = String(text).split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) {
        lines[lines.length - 1].push(
          type ? `<span class="tok-${type}">${esc(part)}</span>` : esc(part));
      }
    });
  };

  if (!family) {
    push(code, null);
  } else {
    const re = langRegex(family);
    re.lastIndex = 0;
    let last = 0, m;
    while ((m = re.exec(code)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m.index > last) push(code.slice(last, m.index), null);
      const type = Object.keys(m.groups).find(k => m.groups[k] !== undefined);
      push(m[0], type);
      last = re.lastIndex;
    }
    if (last < code.length) push(code.slice(last), null);
  }
  return lines.map(parts => parts.join(''));
}

function codeBlock(text, lang, startLine, hlFrom, hlTo) {
  return highlightLines(text, lang).map((line, i) => {
    const num = startLine + i;
    const hl = hlFrom > 0 && num >= hlFrom && num <= hlTo;
    return `<div class="code-line${hl ? ' hl' : ''}"><span class="ln">${num}</span><span class="lc">${line || ' '}</span></div>`;
  }).join('');
}

// ── Markdown ────────────────────────────────────────────────────────────────
// Deliberately small and self-contained. Everything is escaped before any
// markup is added, and only http(s)/mailto links become clickable; images
// render as labels rather than <img>, so a README's badges never turn this
// page into something that makes outbound requests.

function safeUrl(url) {
  const trimmed = String(url).trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

// The URL part tolerates one level of nested parens — Wikipedia-style links
// like (https://x/foo_(bar)) are common — plus an optional "title" suffix.
// The optional title after the URL is matched loosely because the text has
// already been escaped, so a "title" arrives as &quot;title&quot;.
const _URL_PART = '\\(\\s*([^()\\s]*(?:\\([^()]*\\)[^()\\s]*)*)(?:\\s+[^)]*)?\\s*\\)';
const LINK_RE = new RegExp('\\[([^\\]]+)\\]' + _URL_PART, 'g');
const IMAGE_RE = new RegExp('!\\[([^\\]]*)\\]' + _URL_PART, 'g');

function mdInline(text) {
  const spans = [];
  const stash = html => `\u0000S${spans.push(html) - 1}\u0000`;

  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, (m, code) => stash(`<code>${code}</code>`));
  out = out.replace(IMAGE_RE, (m, alt) => stash(`<code>&#9635; ${alt || 'image'}</code>`));
  out = out.replace(LINK_RE, (m, label, url) => {
    const safe = safeUrl(url);
    // `url` came out of already-escaped text, so it cannot break the attribute.
    return safe
      ? stash(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      : stash(`<a class="md-rel" title="relative link: ${url}">${label}</a>`);
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return out.replace(/\u0000S(\d+)\u0000/g, (m, i) => spans[+i]);
}

function renderMarkdown(src) {
  const fences = [];
  const text = String(src).replace(/```[\w+-]*\n([\s\S]*?)```/g, (m, code) =>
    `\u0000F${fences.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`) - 1}\u0000`);

  const lines = text.split('\n');
  const out = [];
  let para = [], list = null;

  const flushPara = () => {
    if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map(i => `<li>${mdInline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\u0000F(\d+)\u0000$/);
    if (fence) { flush(); out.push(fences[+fence[1]]); continue; }
    if (!line.trim()) { flush(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${mdInline(heading[2].replace(/\s*#+\s*$/, ''))}</h${level}>`);
      continue;
    }
    if (/^([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) { flush(); out.push('<hr>'); continue; }

    // A table is a header row followed by a |---|---| separator.
    if (line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      flush();
      const cells = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { body.push(cells(lines[i])); i++; }
      i--;
      out.push(`<table><thead><tr>${head.map(c => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flush(); out.push(`<blockquote>${mdInline(quote[1])}</blockquote>`); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((bullet || numbered)[1]);
      continue;
    }

    if (list && !para.length) {
      // Lazy continuation: a wrapped line belongs to the item above it, not
      // to a new paragraph that would break out of the list.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

export { esc, renderMarkdown, codeBlock, highlightLines, langOf };
