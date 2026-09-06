"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function AutoRefresh({ message = "Waiting for the worker to generate your CV. This page refreshes automatically." }: { message?: string }) {
  const router = useRouter();
  useEffect(() => { const id = setInterval(() => router.refresh(), 5000); return () => clearInterval(id); }, [router]);
  return <p role="status" className="text-sm">{message}</p>;
}
