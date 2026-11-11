import Link from "next/link";
import { DefaultCvAppearance } from "@/components/DefaultCvAppearance";
import { PageHeader } from "@/components/PageHeader";
import { requireUser } from "@/lib/auth";
import { getDefaultCvAppearance } from "@/lib/cv-appearance";

export const dynamic = "force-dynamic";

export default async function CvAppearanceSettingsPage() {
  const user = await requireUser();
  const appearance = await getDefaultCvAppearance(user.id);
  return <div className="max-w-4xl space-y-5">
    <PageHeader title="Default CV appearance" />
    <Link prefetch={false} href="/settings" className="inline-flex min-h-11 items-center text-14 underline">Back to Preferences</Link>
    <DefaultCvAppearance key={JSON.stringify(appearance)} value={appearance} />
  </div>;
}
