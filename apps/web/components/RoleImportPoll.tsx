"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function RoleImportPoll() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") router.refresh();
    }, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [router]);
  return <p role="status" className="text-14 text-muted">Extracting the role. This page updates automatically.</p>;
}
