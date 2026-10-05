import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import markUrl from "../assets/tealbrick-mark.svg";

export type ButtonTone = "default" | "primary" | "danger" | "ghost";

export function BrandMark(props: Omit<HTMLAttributes<HTMLImageElement>, "src" | "alt">) {
  return <img {...props} className={["dg-mark", props.className].filter(Boolean).join(" ")} src={markUrl} alt="" />;
}

export function Button({
  tone = "default",
  size = "default",
  pending = false,
  disabled,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: ButtonTone; readonly size?: "default" | "small"; readonly pending?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || pending}
      aria-busy={pending || props["aria-busy"]}
      data-dg-autofocus={props.autoFocus || undefined}
      className={[
        "dg-button",
        `dg-button--${tone}`,
        size === "small" ? "dg-button--small" : "",
        className,
      ].filter(Boolean).join(" ")}
    />
  );
}

export { CheckboxField, Dialog, Feedback, PageHeader, SelectField, SettingsPage, Sidebar, TextField, TextareaField, SectionNavigation } from "./primitives";
export type { DialogProps, FeedbackState, NavigationItem, SectionNavigationItem } from "./primitives";

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...props} tone="ghost" className={["dg-icon-button", className].filter(Boolean).join(" ")} />;
}

export function Tag({ tone = "default", className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  readonly tone?: "default" | "accent" | "danger" | "success" | "warning";
}) {
  return <span {...props} className={["dg-tag", `dg-tag--${tone}`, className].filter(Boolean).join(" ")} />;
}

export function Field({ label, children, className }: { readonly label: string; readonly children: ReactNode; readonly className?: string }) {
  return (
    <label className={["dg-field", className].filter(Boolean).join(" ")}>
      <span className="dg-field__label">{label}</span>
      {children}
    </label>
  );
}

export function EmptyState({ title, children, action }: { readonly title: string; readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="dg-empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
