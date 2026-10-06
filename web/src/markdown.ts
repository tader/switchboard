import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import http from 'highlight.js/lib/languages/http';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

// Only the languages guides use, to keep the bundle small. `ini` also covers TOML.
for (const [name, lang] of Object.entries({ bash, http, ini, javascript, json, markdown, plaintext, python, typescript, yaml })) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['js', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

const LABELS: Record<string, string> = { bash: 'Shell', json: 'JSON', ini: 'INI', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', yaml: 'YAML', markdown: 'Markdown', http: 'HTTP' };

/** Label for a code block: by the language highlight.js resolves, so aliases such as `js` work too. */
function label(lang: string) {
  if (lang === 'toml') return 'TOML';
  const name = Object.keys(LABELS).find((k) => hljs.getLanguage(k) === hljs.getLanguage(lang));
  return name ? LABELS[name] : '';
}

const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    emptyLangClass: 'hljs language-plaintext',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  { gfm: true },
);

const CALLOUTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

/** Markdown to sanitized HTML, plus the headings for an outline. Guides come from plugins, so nothing in them may run. */
export function renderMarkdown(source: string): { html: string; headings: Heading[] } {
  const raw = md.parse(source, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html');
  const root = doc.body.firstElementChild!;

  // Heading anchors
  const headings: Heading[] = [];
  const used = new Set<string>();
  for (const h of root.querySelectorAll('h2, h3')) {
    let id = slug(h.textContent ?? '') || 'section';
    for (let i = 2; used.has(id); i++) id = `${slug(h.textContent ?? '')}-${i}`;
    used.add(id);
    h.id = id;
    headings.push({ id, text: h.textContent ?? '', level: h.tagName === 'H2' ? 2 : 3 });
  }

  // GitHub-style callouts: > [!NOTE] …
  for (const q of root.querySelectorAll('blockquote')) {
    const p = q.querySelector('p');
    const m = p?.innerHTML.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br>)?\s*/);
    if (!p || !m) continue;
    p.innerHTML = p.innerHTML.slice(m[0].length);
    if (!p.innerHTML.trim()) p.remove();
    q.className = `callout callout-${m[1].toLowerCase()}`;
    const title = doc.createElement('div');
    title.className = 'callout-title';
    title.textContent = CALLOUTS[m[1]];
    q.prepend(title);
  }

  // Code blocks get a header with the language; the copy button is added when mounted.
  for (const pre of root.querySelectorAll('pre')) {
    const lang = pre.querySelector('code')?.className.match(/language-(\S+)/)?.[1] ?? 'plaintext';
    const wrap = doc.createElement('div');
    wrap.className = 'code-block';
    const head = doc.createElement('div');
    head.className = 'code-head';
    const tag = doc.createElement('span');
    tag.textContent = label(lang);
    head.append(tag);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }

  // Tables scroll on their own on narrow screens.
  for (const t of root.querySelectorAll('table')) {
    const wrap = doc.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
  }
  return { html: root.innerHTML, headings };
}
