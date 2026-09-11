import { ChristopherMark } from "@/components/brand";

export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      {/* The drums carry the motion here, so the heading skeleton no longer
          pulses alongside them — two competing animations read as jitter. */}
      <div className="flex items-center gap-3">
        <ChristopherMark size={40} searching id="loading-mark" />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-56 rounded bg-slate-200" />
        <div className="h-32 rounded bg-slate-100" />
      </div>
    </div>
  );
}
