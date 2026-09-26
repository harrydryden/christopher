import type { ReactNode } from "react";
import { Mark } from "@/components/brand";
import { Card } from "@/components/Card";

/**
 * The frame every sign-in page shares, in the app shell's two colours: a brand-green panel with
 * the light-green wordmark (a header on narrow screens, the left column on wide ones) and the form
 * in a centred column on the white ground.
 */
export function AuthShell({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="ds-on-brand flex flex-col items-center justify-center gap-3 px-4 py-8 md:w-2/5 md:shrink-0">
        <h1 className="text-brand-ink" aria-label="AVA">
          <Mark size={72} />
        </h1>
        <p className="text-14 text-brand-ink-muted">Careers page monitor</p>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm">
          <Card raised title={title} bodyClassName="p-4">
            {children}
          </Card>
          {footer && <div className="mt-4 space-y-1 text-center text-13 text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

export function GoogleButton({ next, label = "Continue with Google" }: { next?: string; label?: string }) {
  const href = next && next !== "/" ? `/auth/google?next=${encodeURIComponent(next)}` : "/auth/google";
  return (
    <a
      href={href}
      className="ds-pixel ds-press inline-flex w-full items-center justify-center gap-2 border-2 border-line bg-raised px-4 py-2 text-12 text-fg no-underline hover:bg-fg hover:text-bg"
    >
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" className="shrink-0">
        <path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4c-.2 1.2-.9 2.3-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z" />
        <path fill="currentColor" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6C4.8 19.8 8.1 22 12 22z" />
        <path fill="currentColor" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1C2.4 8.8 2 10.4 2 12s.4 3.2 1.1 4.6L6.4 14z" />
        <path fill="currentColor" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9C17 2.9 14.7 2 12 2 8.1 2 4.8 4.2 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" />
      </svg>
      {label}
    </a>
  );
}

export function AuthDivider() {
  return (
    <div className="my-4 flex items-center gap-3 text-12 text-muted" aria-hidden="true">
      <span className="h-0.5 flex-1 bg-line-muted" />
      or
      <span className="h-0.5 flex-1 bg-line-muted" />
    </div>
  );
}
