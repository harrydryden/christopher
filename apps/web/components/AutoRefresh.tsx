"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
export function AutoRefresh({ message = "Waiting for the worker to generate your CV. This page refreshes automatically." }: { message?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (pending) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") startTransition(() => router.refresh()); }, 10000);
    return () => clearInterval(id);
  }, [router, pending]);
  return <p role="status" className="text-sm">{message}</p>;
}
