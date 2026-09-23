"use client";

import { createContext, useContext, useTransition, type FormEvent, type FormHTMLAttributes, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Monogram } from "@/components/brand";

const PendingContext = createContext(false);

/**
 * A GET form that navigates client-side instead of reloading the document.
 *
 * A native `method="get"` form throws the whole page away and fetches it again —
 * scripts, styles, fonts, every server query — which is most of what made
 * searching and filtering feel slow. This serialises the same fields into the
 * same URL and hands it to the router inside a transition, so the shell stays,
 * only the page's server payload is fetched, and `isPending` is true while it
 * is in flight. `SearchPending` renders the turning mark from that state.
 */
export function SearchForm({ action, onSubmit, children, ...rest }: Omit<FormHTMLAttributes<HTMLFormElement>, "method" | "onSubmit"> & {
  action: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  function submit(event: FormEvent<HTMLFormElement>) {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value !== "") params.append(key, value);
    }
    const [path, hash] = action.split("#");
    const query = params.toString();
    startTransition(() => router.push(`${path}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`));
  }
  return (
    <PendingContext.Provider value={isPending}>
      <form method="get" action={action} onSubmit={submit} aria-busy={isPending || undefined} {...rest}>
        {children}
      </form>
    </PendingContext.Provider>
  );
}

/** The turning mark while the enclosing `SearchForm` is navigating. */
export function SearchPending({ size = 16 }: { size?: number }) {
  const pending = useContext(PendingContext);
  return (
    <span role="status" aria-live="polite" className="inline-flex min-w-4 items-center self-center">
      {pending && <Monogram size={size} searching title="Searching" />}
    </span>
  );
}
