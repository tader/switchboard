import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react';
import { api } from '../api';
import { Alert, Empty, Spinner } from '../components/ui';
import { copy, cx, useResource } from '../lib';
import { renderMarkdown } from '../markdown';

export interface DocInfo {
  id: string;
  title: string;
  section: string;
  source: string;
  sourceName: string;
  services: string[];
}

export function Docs() {
  const loc = useLocation();
  const navigate = useNavigate();
  const list = useResource(() => api<DocInfo[]>('/docs'));
  const id = decodeURIComponent(loc.pathname.replace(/^\/docs\/?/, '')) || list.data?.[0]?.id;
  const doc = useResource(async () => (id ? api<DocInfo & { markdown: string }>(`/docs/${id}`) : null), [id]);
  const rendered = useMemo(() => (doc.data ? renderMarkdown(doc.data.markdown) : null), [doc.data]);
  const body = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);

  // Copy buttons, external links, and jumping to the #section in the address.
  useEffect(() => {
    const el = body.current;
    if (!el || !rendered) return;
    for (const head of el.querySelectorAll('.code-head')) {
      if (head.querySelector('button')) continue;
      const pre = head.nextElementSibling as HTMLElement;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Copy';
      b.onclick = async () => {
        await copy(pre.querySelector('code')?.textContent?.replace(/\n$/, '') ?? '');
        b.textContent = 'Copied';
        b.dataset.done = '1';
        setTimeout(() => {
          b.textContent = 'Copy';
          delete b.dataset.done;
        }, 1400);
      };
      head.appendChild(b);
    }
    for (const a of el.querySelectorAll('a[href]')) {
      if (/^https?:/.test(a.getAttribute('href')!)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer');
      }
    }
    const main = el.closest('main');
    if (loc.hash) document.getElementById(decodeURIComponent(loc.hash.slice(1)))?.scrollIntoView();
    else main?.scrollTo({ top: 0 });
  }, [rendered, loc.hash]);

  // The outline follows the section being read.
  useEffect(() => {
    const el = body.current;
    const main = el?.closest('main');
    if (!el || !main || !rendered?.headings.length) return;
    const targets = rendered.headings.map((h) => document.getElementById(h.id)).filter(Boolean) as HTMLElement[];
    const update = () => {
      const top = main.getBoundingClientRect().top + 96;
      let current = targets[0]?.id ?? null;
      for (const t of targets) if (t.getBoundingClientRect().top <= top) current = t.id;
      // At the bottom of the page, the last section is the current one.
      if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) current = targets.at(-1)?.id ?? current;
      setActive(current);
    };
    update();
    main.addEventListener('scroll', update, { passive: true });
    return () => main.removeEventListener('scroll', update);
  }, [rendered]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || e.metaKey || e.ctrlKey || a.target === '_blank') return;
    if (href.startsWith('/')) {
      e.preventDefault();
      navigate(href);
    } else if (href.startsWith('#')) {
      e.preventDefault();
      jump(href.slice(1));
    }
  };
  const jump = (target: string) => {
    history.replaceState(null, '', `#${target}`);
    document.getElementById(decodeURIComponent(target))?.scrollIntoView({ behavior: 'smooth' });
  };

  const sections = useMemo(() => {
    const m = new Map<string, DocInfo[]>();
    for (const d of list.data ?? []) m.set(d.section, [...(m.get(d.section) ?? []), d]);
    return [...m.entries()];
  }, [list.data]);
  const index = list.data?.findIndex((d) => d.id === id) ?? -1;
  const prev = index > 0 ? list.data![index - 1] : undefined;
  const next = index >= 0 && list.data && index < list.data.length - 1 ? list.data[index + 1] : undefined;
  const outline = rendered?.headings.filter((h) => h.level === 2) ?? [];

  if (list.data && !list.data.length) return <Empty icon={<BookOpen className="size-5" />} title="No guides" />;

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
      <nav className="shrink-0 lg:sticky lg:top-0 lg:w-52 lg:self-start" aria-label="Guides">
        {sections.map(([section, docs]) => (
          <div key={section} className="mb-5">
            <div className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{section}</div>
            <ul className="flex flex-wrap gap-0.5 lg:flex-col">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/docs/${d.id}`}
                    className={cx(
                      'block rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
                      d.id === id
                        ? 'bg-white font-medium text-zinc-900 shadow-xs ring-1 ring-zinc-200 dark:bg-zinc-800/80 dark:text-white dark:ring-zinc-700/60'
                        : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100',
                    )}
                  >
                    {d.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <article className="min-w-0 flex-1">
        <div className="paper">
          {doc.error ? (
            <Alert>{doc.error.message}</Alert>
          ) : !rendered || !doc.data ? (
            <div className="flex justify-center py-24">
              <Spinner className="size-5" />
            </div>
          ) : (
            <>
              <div className="mb-6 flex items-center gap-2 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                {doc.data.section}
                {doc.data.source !== 'hub' && <span className="font-normal text-zinc-400">· from the {doc.data.sourceName} plugin</span>}
              </div>
              <div ref={body} onClick={onClick} className="doc" dangerouslySetInnerHTML={{ __html: rendered.html }} />
              {(prev || next) && (
                <div className="mt-14 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-6 dark:border-zinc-800">
                  {prev ? (
                    <Link to={`/docs/${prev.id}`} className="pager">
                      <span className="flex items-center gap-1 text-xs text-zinc-400">
                        <ArrowLeft className="size-3.5" /> Previous
                      </span>
                      <span className="font-medium">{prev.title}</span>
                    </Link>
                  ) : (
                    <span />
                  )}
                  {next && (
                    <Link to={`/docs/${next.id}`} className="pager items-end text-right">
                      <span className="flex items-center gap-1 text-xs text-zinc-400">
                        Next <ArrowRight className="size-3.5" />
                      </span>
                      <span className="font-medium">{next.title}</span>
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </article>

      {outline.length > 2 && (
        <aside className="hidden w-48 shrink-0 xl:sticky xl:top-0 xl:block xl:self-start" aria-label="On this page">
          <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">On this page</div>
          <ul className="border-l border-zinc-200 dark:border-zinc-800">
            {outline.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    jump(h.id);
                  }}
                  className={cx(
                    '-ml-px block border-l py-1 pl-3 text-[12.5px] leading-snug transition-colors',
                    active === h.id
                      ? 'border-indigo-500 font-medium text-zinc-900 dark:border-indigo-400 dark:text-zinc-100'
                      : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
