/**
 * What `addCompanies` reports through its redirect (`?added=&followed=&skipped=`). Both company
 * tabs read it: the Discover tab adds by domain and comes back to itself, and an older link can
 * still land on Tracked companies.
 */
export function AddedNotice({ added, followed, skipped, className = "" }: { added?: string; followed?: string; skipped?: string; className?: string }) {
  if (added === undefined) return null;
  return (
    <div role="status" className={`border-2 border-ok px-3 py-2 text-14 text-ok ${className}`}>
      Added {added.slice(0, 6)} new {added === "1" ? "company" : "companies"}.
      {followed && <span className="block">Followed {followed.slice(0, 6)} already-tracked {followed === "1" ? "company" : "companies"}; their matching roles are in your table now.</span>}
      {skipped && <span className="block">Skipped (already yours or invalid): {skipped.slice(0, 1000)}</span>}
    </div>
  );
}
