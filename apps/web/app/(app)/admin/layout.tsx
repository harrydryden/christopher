import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Everything under /admin is for administrators only; anyone else gets a plain 404, not a hint that it exists. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return <>{children}</>;
}
