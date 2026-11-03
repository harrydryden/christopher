"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unlinkLinkedIn } from "@/app/actions/linkedin";

/** Disconnecting authentication leaves profile imports untouched; the server guards the last method. */
export function LinkedInDisconnectControl({ canDisconnect }: { canDisconnect: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  return <div className="space-y-2">
    {canDisconnect ? <button type="button" className="min-h-11 border border-line-muted px-3 text-13"
      disabled={pending} onClick={() => start(async () => {
        setMessage(null);
        try {
          const result = await unlinkLinkedIn();
          if (!result.ok) setMessage({ error: true, text: result.error });
          else { setMessage({ error: false, text: "LinkedIn sign-in disconnected. Your Experience and CVs are unchanged." }); router.refresh(); }
        } catch { setMessage({ error: true, text: "Could not disconnect LinkedIn. Try again." }); }
      })}>{pending ? "Disconnecting…" : "Disconnect LinkedIn sign-in"}</button>
      : <p className="text-12 text-muted">Set a password or link another sign-in method before disconnecting LinkedIn.</p>}
    {message && <p role={message.error ? "alert" : "status"} className={message.error ? "text-13 text-danger" : "text-13 text-muted"}>{message.text}</p>}
  </div>;
}
