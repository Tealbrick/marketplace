import { useEffect, useId, useRef } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const classes = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(" ");

type FieldMessage = { label: string; description?: string; error?: string };

export function TextField({ label, description, error, id: providedId, className, ...props }: InputHTMLAttributes<HTMLInputElement> & FieldMessage) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const describedBy = [props["aria-describedby"], description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return <div className="dg-field">
    <label className="dg-field__label" htmlFor={id}>{label}{props.required && <span aria-hidden="true"> *</span>}</label>
    <input {...props} id={id} data-dg-autofocus={props.autoFocus || undefined} className={classes("dg-input", className)} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={describedBy} />
    {description && <p id={`${id}-description`} className="dg-field__description">{description}</p>}
    {error && <p id={`${id}-error`} className="dg-field__error">{error}</p>}
  </div>;
}

export function TextareaField({ label, description, error, id: providedId, className, rows = 4, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldMessage) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const describedBy = [props["aria-describedby"], description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return <div className="dg-field">
    <label className="dg-field__label" htmlFor={id}>{label}{props.required && <span aria-hidden="true"> *</span>}</label>
    <textarea {...props} rows={rows} id={id} data-dg-autofocus={props.autoFocus || undefined} className={classes("dg-input", "dg-textarea", className)} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={describedBy} />
    {description && <p id={`${id}-description`} className="dg-field__description">{description}</p>}
    {error && <p id={`${id}-error`} className="dg-field__error">{error}</p>}
  </div>;
}

export function SelectField({ label, description, error, id: providedId, className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & FieldMessage) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return <div className="dg-field">
    <label className="dg-field__label" htmlFor={id}>{label}{props.required && <span aria-hidden="true"> *</span>}</label>
    <select {...props} id={id} className={classes("dg-input", className)} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={[props["aria-describedby"], description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined}>{children}</select>
    {description && <p id={`${id}-description`} className="dg-field__description">{description}</p>}
    {error && <p id={`${id}-error`} className="dg-field__error">{error}</p>}
  </div>;
}

export function CheckboxField({ label, description, id: providedId, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & Omit<FieldMessage, "error">) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return <div className="dg-checkbox-field">
    <input {...props} type="checkbox" id={id} className={classes("dg-checkbox", className)} aria-describedby={[props["aria-describedby"], description && `${id}-description`].filter(Boolean).join(" ") || undefined} />
    <div><label htmlFor={id}>{label}</label>{description && <p id={`${id}-description`} className="dg-field__description">{description}</p>}</div>
  </div>;
}

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children?: ReactNode;
  footer?: ReactNode;
  kind?: "dialog" | "alertdialog";
};

/** The browser's modal dialog provides top-layer isolation and focus containment. */
export function Dialog({ open, onOpenChange, title, description, children, footer, kind = "dialog" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-dg-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="dg-dialog" role={kind} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); onOpenChange(false); }}
    onClose={() => { if (open && !ref.current?.open) onOpenChange(false); }}>
    <header className="dg-dialog__header">
      <div><h2 id={`${id}-title`}>{title}</h2><p id={`${id}-description`}>{description}</p></div>
      <button type="button" className="dg-button dg-button--ghost dg-icon-button" aria-label="Close dialog" onClick={() => onOpenChange(false)}>×</button>
    </header>
    {children && <div className="dg-dialog__body">{children}</div>}
    {footer && <footer className="dg-dialog__footer">{footer}</footer>}
  </dialog>;
}

export type FeedbackState = "loading" | "empty" | "error" | "forbidden" | "unavailable" | "pending" | "success";
const stateLabels: Record<FeedbackState, string> = { loading: "Loading", empty: "Empty", error: "Error", forbidden: "Access denied", unavailable: "Unavailable", pending: "Pending", success: "Confirmed" };

export function Feedback({ state, title, children, action }: { state: FeedbackState; title: string; children: ReactNode; action?: ReactNode }) {
  return <section className={`dg-feedback dg-feedback--${state}`} role={state === "error" ? "alert" : "status"} aria-busy={state === "loading" || undefined}>
    <span className="dg-feedback__state">{stateLabels[state]}</span><h2>{title}</h2><div className="dg-feedback__description">{children}</div>{action && <div className="dg-feedback__action">{action}</div>}
  </section>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="dg-page-header"><div>{eyebrow && <p className="dg-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="dg-page-description">{description}</p>}</div>{actions && <div className="dg-page-header__actions">{actions}</div>}</header>;
}

/** Layout only: the app owns its route, persistence, dirty navigation guard and authority. */
export function SettingsPage({ title = "Settings", description, children, actions, dirty = false }: { title?: string; description: string; children: ReactNode; actions: ReactNode; dirty?: boolean }) {
  return <section className="dg-settings-page"><PageHeader eyebrow="Preferences & configuration" title={title} description={description} /><div className="dg-settings-page__content">{children}</div><footer className="dg-settings-page__footer"><span role="status">{dirty ? "Unsaved changes" : "No unsaved changes"}</span><div className="dg-page-header__actions">{actions}</div></footer></section>;
}

export type NavigationItem = { id: string; label: string; href: string; current?: boolean; unavailable?: boolean; badge?: string };

export type SectionNavigationItem<T extends string = string> = { id: T; label: string; icon?: ReactNode; disabled?: boolean };

/** The app owns URL/history/dirty guards. These are navigation buttons, not ARIA tabs. */
export function SectionNavigation<T extends string>({ label = "Settings sections", items, current, onSelect }: { label?: string; items: readonly SectionNavigationItem<T>[]; current: T; onSelect: (id: T) => void }) {
  return <nav className="dg-section-navigation" aria-label={label}>{items.map(item =>
    <button key={item.id} type="button" className="dg-section-navigation__item" disabled={item.disabled} aria-current={item.id === current ? "page" : undefined} onClick={() => { if (item.id !== current) onSelect(item.id); }}>
      {item.icon && <span className="dg-section-navigation__icon" aria-hidden="true">{item.icon}</span>}{item.label}
    </button>
  )}</nav>;
}

/** Display already-filtered, authorized contributions; this is not an access check. */
export function Sidebar({ label, brand, items, footer }: { label: string; brand: ReactNode; items: readonly NavigationItem[]; footer?: ReactNode }) {
  return <aside className="dg-sidebar"><div className="dg-sidebar__brand">{brand}</div><nav aria-label={label}>{items.map(item => item.unavailable
    ? <span key={item.id} className="dg-sidebar__link" aria-disabled="true">{item.label}<span className="dg-sidebar__badge">Unavailable</span></span>
    : <a key={item.id} className="dg-sidebar__link" href={item.href} aria-current={item.current ? "page" : undefined}>{item.label}{item.badge && <span className="dg-sidebar__badge">{item.badge}</span>}</a>)}</nav>{footer && <footer className="dg-sidebar__footer">{footer}</footer>}</aside>;
}
