"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createCvApplicationContext } from "@/app/actions/cv-editing";

/** Opening an application workspace is free; Auto generation is a later explicit choice. */
export function CvWorkspaceEntry({ jobId, separate = false }: { jobId: string; separate?: boolean }) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef(separate ? `new:${crypto.randomUUID()}` : `job:${jobId}`);
  async function open() {
    if (pending) return;
    setPending(true); setError(null);
    try {
      const result = await createCvApplicationContext({ jobId,
        requestKey: requestKey.current,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      if (!result.ok) setError(result.error);
      else router.push(`/cv/context/${result.contextId}`);
    } catch { setError("Could not open this application. Your pasted description is still here."); }
    finally { setPending(false); }
  }
  return <div className="space-y-2 text-14">
    <label className="block space-y-1"><span className="text-12 font-medium">Full role description, if the saved copy is incomplete</span>
      <textarea className="min-h-20 w-full border border-line-muted bg-raised p-2" maxLength={60000}
        value={description} onChange={event => setDescription(event.target.value)}
        placeholder="Paste the original advert when the saved description is incomplete." /></label>
    <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending} onClick={open}>
      {pending ? "Opening…" : separate ? "Start a separate application · free" : "Prepare CV · free"}
    </button>
    <p className="text-12 text-muted">Choose Auto, Refine or Manual there. A new Auto generation uses one CV credit only when you request it.</p>
    {error && <p role="alert" className="text-12 text-danger">{error}</p>}
  </div>;
}
