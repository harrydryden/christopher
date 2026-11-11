import { PageHeader } from "@/components/PageHeader";
import { CvAboutContactForm } from "@/components/CvAboutContactForm";
import { requireUser } from "@/lib/auth";
import { getOwnCvLibrary } from "@/lib/queries/cv";
import { openStoredLibrary } from "@/lib/cv-library-open";

export const dynamic = "force-dynamic";

export default async function AboutPage() {
  const user = await requireUser();
  const library = await getOwnCvLibrary(user.id);
  const content = library ? openStoredLibrary(library.content) : null;
  return <div className="max-w-4xl space-y-5">
    <PageHeader title="About you and contact" />
    <CvAboutContactForm initial={{ version: library?.version ?? 0, values: {
      name: content?.name ?? user.name ?? "", email: content?.email ?? "", phone: content?.phone ?? "",
      location: content?.location ?? "", linkedinUrl: content?.linkedinUrl ?? "", websiteUrl: content?.websiteUrl ?? "",
      contact: content?.contact ?? "", profile: content?.profile ?? "",
    } }} />
  </div>;
}
