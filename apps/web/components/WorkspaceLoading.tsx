import { Wordmark } from "@/components/brand";

export function WorkspaceLoading({ label }: { label: string }) {
  return <div role="status" aria-live="polite" className="space-y-4">
    <div className="flex items-center gap-3">
      <Wordmark size={32} searching title={label} className="text-brand" />
      <p className="text-14 text-muted">{label}…</p>
    </div>
    <div aria-hidden="true" className="space-y-4">
      <div className="h-8 w-56 max-w-full bg-sunken" />
      <div className="h-32 border-2 border-line-faint" />
    </div>
  </div>;
}
