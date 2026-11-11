import Link from "next/link";
import type { ComponentProps } from "react";
import type { CvLibraryEditor } from "./CvLibraryEditor";

/** Contact editing is a named task; the career page does not load or serialise its editor. */
export function CvAboutEditor(_props: ComponentProps<typeof CvLibraryEditor>) {
  return <Link prefetch={false} href="/library/about" className="inline-flex min-h-11 items-center text-14 underline">
    About you and contact
  </Link>;
}
