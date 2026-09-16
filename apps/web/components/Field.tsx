import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

/**
 * One shape for every control: the page ground inside a 2px muted border that
 * goes full-contrast on focus. Exported as class strings as well as components
 * because server components style raw inputs directly in several places.
 */
export const inputClass =
  "w-full border-2 border-line-muted bg-bg px-3 py-2 font-mono text-14 text-fg " +
  "placeholder:text-faint focus:border-line focus:outline-none";

export const selectClass = `${inputClass} ds-select`;

/** Field labels are the one place small caps tracking is used. */
export const labelClass = "ds-label";

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = "",
}: {
  label?: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const Tag = htmlFor ? "div" : "label";
  return (
    <Tag className={`flex flex-col gap-1.5 text-14 ${className}`}>
      {label && (
        htmlFor
          ? <label htmlFor={htmlFor} className={labelClass}>{label}</label>
          : <span className={labelClass}>{label}</span>
      )}
      {children}
      {hint && <span className="text-12 text-muted">{hint}</span>}
    </Tag>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClass} ${className}`} {...rest} />;
}

export function Textarea({ className = "", rows = 3, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={`${inputClass} resize-y ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${selectClass} ${className}`} {...rest}>{children}</select>;
}

export function Checkbox({ label, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-14 ${className}`}>
      <input type="checkbox" className="h-4 w-4 m-0" {...rest} />
      {label}
    </label>
  );
}
