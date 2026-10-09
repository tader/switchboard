import {
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
  createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { copy, cx } from '../lib';

export function Table({ children, label, layout = 'fixed' }: { children: ReactNode; label: string; layout?: 'fixed' | 'auto' }) {
  return <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
    <table aria-label={label} className={cx(layout === 'auto' ? 'table-auto' : 'table-fixed', 'w-full text-left text-[13px] [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-zinc-500 [&_td]:px-3 [&_td]:py-2 [&_tbody_tr]:border-t [&_tbody_tr]:border-zinc-100 dark:[&_tbody_tr]:border-zinc-800 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-zinc-50 dark:[&_tbody_tr:hover]:bg-zinc-800/40')}>
      {children}
    </table>
  </div>;
}

// --- buttons ---

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 shadow-sm shadow-indigo-950/20 disabled:bg-indigo-600/50',
  secondary:
    'bg-white text-zinc-800 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50 shadow-xs dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700/80 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 shadow-sm disabled:bg-rose-600/50',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// --- form controls ---

const control =
  'w-full rounded-lg bg-white px-3 text-sm text-zinc-900 ring-1 ring-inset ring-zinc-200 placeholder:text-zinc-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700/80 dark:placeholder:text-zinc-500 dark:focus:ring-indigo-400';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, 'h-9', className)} {...rest} />;
});

export function SecretInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? 'text' : 'password'} className={cx('pr-9', props.className)} autoComplete="off" spellCheck={false} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(!show)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
        aria-label={show ? 'Hide' : 'Show'}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(control, 'py-2', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select className={cx(control, 'h-9 appearance-none pr-8')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-indigo-600' : 'bg-zinc-300 dark:bg-zinc-700',
      )}
    >
      <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Checkbox({ checked, onChange, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className={cx('size-4 shrink-0 rounded border-zinc-300 accent-indigo-600', className)}
      {...rest}
    />
  );
}

export function FormField({ label, description, children, htmlFor, optional }: { label: ReactNode; description?: ReactNode; children: ReactNode; htmlFor?: string; optional?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline gap-2 text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
        {label}
        {optional && <span className="text-xs font-normal text-zinc-400">Optional</span>}
      </label>
      {children}
      {description && <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p>}
    </div>
  );
}

// --- display ---

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'green' | 'red' | 'amber' | 'indigo'; className?: string }) {
  const tones = {
    neutral: 'bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
    red: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-zinc-400', className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-800">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">{icon}</div>}
      <h3 className="text-sm font-semibold">{title}</h3>
      {children && <div className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'red', children, className }: { tone?: 'red' | 'amber' | 'indigo'; children: ReactNode; className?: string }) {
  const tones = {
    red: 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-500/20',
    amber: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20',
    indigo: 'bg-indigo-50 text-indigo-900 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-200 dark:ring-indigo-500/20',
  };
  return <div className={cx('rounded-lg px-3 py-2 text-[13px] leading-relaxed ring-1 ring-inset', tones[tone], className)}>{children}</div>;
}

export function ServiceIcon({ icon, name, size = 'md' }: { icon?: string; name: string; size?: 'sm' | 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [icon]);
  const box = { sm: 'size-6 rounded-md p-1', md: 'size-9 rounded-lg p-1.5', lg: 'size-11 rounded-xl p-2' }[size];
  if (icon && !failed) {
    const src = icon.startsWith('<') ? `data:image/svg+xml;utf8,${encodeURIComponent(icon)}` : icon;
    return (
      <span className={cx('flex shrink-0 items-center justify-center bg-white ring-1 ring-zinc-200 dark:bg-zinc-100 dark:ring-zinc-700', box)}>
        <img src={src} alt="" onError={() => setFailed(true)} referrerPolicy="no-referrer" className="size-full object-contain" />
      </span>
    );
  }
  return (
    <span className={cx('flex shrink-0 items-center justify-center bg-indigo-100 font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300', box)}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function Avatar({ src, label, className }: { src?: string; label: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) return <img src={src} alt="" onError={() => setFailed(true)} referrerPolicy="no-referrer" className={cx('size-7 shrink-0 rounded-full object-cover', className)} />;
  return (
    <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', className)}>
      {label.charAt(0)}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      className={className}
      onClick={async (e) => {
        e.stopPropagation();
        await copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
    </IconButton>
  );
}

export function CopyField({ value, className, multiline }: { value: string; className?: string; multiline?: boolean }) {
  return (
    <div className={cx('group flex items-start gap-1 rounded-lg bg-zinc-100 py-1 pl-3 pr-1 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800', className)}>
      <code className={cx('min-w-0 flex-1 py-1 font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200', multiline ? 'whitespace-pre-wrap break-all' : 'truncate')}>{value}</code>
      <CopyButton text={value} className="size-7" />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div role="tablist" className={cx('flex gap-4 border-b border-zinc-200 dark:border-zinc-800', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 pb-2 pt-1 text-[13px] font-medium transition-colors',
            value === t.value
              ? 'border-indigo-600 text-zinc-900 dark:border-indigo-400 dark:text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// --- dialog ---

export function Dialog({
  open, onClose, title, description, children, footer, size = 'md',
}: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return null;
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return createPortal(
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx(
        'm-auto max-h-[min(90vh,900px)] w-[calc(100%-2rem)] animate-pop overflow-hidden rounded-2xl bg-white p-0 text-zinc-900 shadow-2xl ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-800',
        width,
      )}
    >
      <div className="flex max-h-[min(90vh,900px)] flex-col">
        <div className="flex items-start gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-1.5 -mt-0.5">
            <X className="size-4" />
          </IconButton>
        </div>
        {children && <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-1">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">{footer}</div>}
      </div>
    </dialog>,
    document.body,
  );
}

// --- dropdown menu ---

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

export function Menu({
  trigger, items, align = 'end', width = 208, block, footer,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  items: (MenuItem | 'separator' | { heading: string })[];
  align?: 'start' | 'end';
  width?: number;
  /** The trigger fills its container. */
  block?: boolean;
  /** Read-only information below the menu actions. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const w = width;
    const left = align === 'end' ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 4;
    const h = panel.current?.offsetHeight ?? 0;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // Close when the page scrolls (the menu would drift from its button), not when the menu's own list scrolls.
    const scroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  const visible = items.filter((i) => i === 'separator' || 'heading' in i || !i.hidden);
  return (
    <>
      <span ref={anchor} className={block ? 'flex w-full' : 'inline-flex'}>
        {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
            className="scrollbar-thin fixed z-50 max-h-[min(480px,70vh)] animate-pop overflow-y-auto rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800"
          >
            {visible.map((item, i) =>
              item === 'separator' ? (
                <div key={i} className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
              ) : 'heading' in item ? (
                <div key={i} className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  {item.heading}
                </div>
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50',
                    item.danger
                      ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10'
                      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
                  )}
                >
                  {item.icon && <span className="flex min-w-4 shrink-0 items-center justify-center [&>svg]:size-4 [&>svg]:opacity-70">{item.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ),
            )}
            {footer && <div className="mt-1 border-t border-zinc-100 px-2.5 py-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">{footer}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

// --- toasts & confirm ---

interface Toast {
  id: number;
  message: ReactNode;
  tone: 'success' | 'error' | 'info';
}

const ToastCtx = createContext<(message: ReactNode, tone?: Toast['tone']) => void>(() => {});
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirm?: string;
  danger?: boolean;
}

export function Providers({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirm] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const toast = useCallback((message: ReactNode, tone: Toast['tone'] = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ ...o, resolve })), []);
  const settle = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirm(null);
  };
  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <Dialog
          open={!!confirmState}
          onClose={() => settle(false)}
          size="sm"
          title={confirmState?.title}
          footer={
            <>
              <Button onClick={() => settle(false)}>Cancel</Button>
              <Button variant={confirmState?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>
                {confirmState?.confirm ?? 'Confirm'}
              </Button>
            </>
          }
        >
          {confirmState?.message && <div className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">{confirmState.message}</div>}
        </Dialog>
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100%-2rem))] flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={cx(
                'pointer-events-auto flex animate-pop items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px] shadow-lg ring-1',
                'bg-white text-zinc-800 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-800',
              )}
            >
              <span className={cx('mt-1 size-2 shrink-0 rounded-full', t.tone === 'success' ? 'bg-emerald-500' : t.tone === 'error' ? 'bg-rose-500' : 'bg-indigo-500')} />
              <div className="min-w-0 flex-1 break-words">{t.message}</div>
              <button className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
export const useConfirm = () => useContext(ConfirmCtx);

// --- page chrome ---

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800', className)}>{children}</div>;
}
