"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";

/**
 * What a page or an action that fails unexpectedly shows, inside the workspace rather than as a
 * bare crash page. Expected refusals come back as sentences on the form that asked; this is the
 * backstop for everything else. A production build withholds the thrown message — it may carry SQL
 * or stored content — so the page says what can be done and gives the reference the server logged.
 */
export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const detail = process.env.NODE_ENV === "production" ? null : error.message;
  return (
    <div role="alert">
      <Card title="Something went wrong">
        <div className="space-y-3">
          <p className="text-14">
            This page could not finish what it was doing. Try again; if it happens again, reload the page to see what was saved.
          </p>
          {detail && <p className="text-12 break-words text-muted">{detail}</p>}
          {error.digest && <p className="text-12 text-muted">Reference {error.digest}</p>}
          <Button
            variant="primary"
            size="sm"
            onClick={() => startTransition(() => {
              router.refresh();
              reset();
            })}
          >
            Try again
          </Button>
        </div>
      </Card>
    </div>
  );
}
