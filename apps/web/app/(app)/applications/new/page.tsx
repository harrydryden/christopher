import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CvPastedApplicationEntry } from "@/components/CvPastedApplicationEntry";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewApplicationPage() {
  await requireUser();
  return <div className="max-w-4xl space-y-5">
    <PageHeader title="New application" actions={<Link prefetch={false} href="/applications" className="inline-flex min-h-11 items-center underline">Back to Applications</Link>} />
    <CvPastedApplicationEntry />
  </div>;
}
