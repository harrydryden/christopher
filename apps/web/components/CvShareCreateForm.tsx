"use client";
/**
 * Opening a share link, and showing it once.
 *
 * The link is in the action's result rather than on the page, because that is the only moment it
 * exists: the token is hashed on its way into the database and never stored, so a reload cannot
 * bring it back. That is also why the copy control matters — this is the reader's one chance to
 * take the link, and a reader who loses it opens a new one.
 *
 * The fields come in as children, rendered on the server, so the day choices and the caps stay in
 * one module rather than being written a second time for the browser.
 */
import { useActionState, useState, type ReactNode } from "react";
import { createCvShareLink } from "@/app/actions/cv-share";
import type { CvShareResult } from "@/lib/cv-share";
import { Button } from "@/components/Button";

const INITIAL: CvShareResult = { ok: true };

export function CvShareCreateForm({ draftId, children }: { draftId: string; children: ReactNode }) {
  const [state, formAction, pending] = useActionState(createCvShareLink.bind(null, draftId), INITIAL);
  const [copied, setCopied] = useState(false);
  const link = state.ok ? state.link : undefined;
  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(new URL(link, window.location.href).href);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the link; selecting it is the fallback.
      setCopied(false);
    }
  }
  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-col gap-3">
        {children}
        {!state.ok && (
          <p role="alert" className="text-14 text-danger">
            {state.error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create a share link"}
          </Button>
        </div>
      </form>
      {link && (
        <div role="status" className="space-y-2 border-2 border-line-muted bg-sunken p-3">
          <p className="ds-label">Your link — copy it now; it is not shown again</p>
          <p className="break-all text-14">
            <a className="underline" href={link} target="_blank" rel="noopener noreferrer">
              {link}
            </a>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            {state.ok && state.message && <span className="text-12 text-muted">{state.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
