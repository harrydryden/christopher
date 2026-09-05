"use client";

import { buttonClass, type ButtonProps } from "@/components/Button";

/** A submit button that requires a confirm() before letting the enclosing form submit. */
export function ConfirmSubmitButton({
  confirmMessage,
  variant = "danger",
  size = "sm",
  className = "",
  children,
  ...rest
}: ButtonProps & { confirmMessage: string }) {
  return (
    <button
      type="submit"
      className={buttonClass(variant, size, className)}
      onClick={(e) => {
        if (!confirm(confirmMessage)) e.preventDefault();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
