import { Mark } from "@/components/brand";

export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      {/* The wheel carries the motion here, so the skeleton no longer pulses
          alongside it — two competing animations read as jitter. */}
      <div className="flex items-center gap-3">
        <Mark size={32} searching />
        <p className="text-14 text-muted">Loading…</p>
      </div>
      <div className="space-y-4">
        <div className="h-8 w-56 bg-sunken" />
        <div className="h-32 border-2 border-line-faint" />
      </div>
    </div>
  );
}
