import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

// No focus ring here: globals.css gives every control the same one. A
// `focus-visible:outline-*` utility would outrank it and desynchronise buttons
// from the rest of the app, which is exactly what used to happen.
//
// `ds-press` is the shared press behaviour: the hard shadow collapses and the
// button shifts +2,+2, so it reads as physically pushed down onto the page.
const BASE =
  "ds-pixel ds-press inline-flex items-center justify-center gap-1.5 border-2 leading-[1.4] " +
  "transition-colors duration-[120ms] ease-step-2 disabled:opacity-40 disabled:pointer-events-none";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Inverted ink on the page ground, carrying the 4px shadow.
  primary: "bg-accent text-accent-fg border-accent shadow-hard-2 hover:bg-bg hover:text-fg hover:border-fg",
  secondary: "bg-raised text-fg border-line hover:bg-fg hover:text-bg",
  // `text-bg` rather than black: on the light theme the danger hue is dark
  // enough that black text would fail contrast against it.
  danger: "bg-danger text-bg border-danger shadow-hard-2 hover:bg-fg hover:text-bg hover:border-fg",
  ghost: "bg-transparent text-muted border-transparent hover:text-fg hover:underline",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-10",
  md: "px-4 py-2 text-12",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className = ""): string {
  return `${BASE} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "secondary", size = "md", className = "", type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

/** A link styled as a button. Same shape, same states, no underline. */
export function buttonLinkClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className = ""): string {
  return buttonClass(variant, size, `no-underline ${className}`);
}
