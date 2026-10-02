/** A quiet usage line beside company controls; payment actions stay in Account. */
export function CompanyCapacityReadout({ active, capacity, remaining, plan, technicalMax }: {
  active: number; capacity: number; remaining: number; plan: string; technicalMax: number;
}) {
  const atTechnicalLimit = capacity >= technicalMax && remaining === 0;
  return <p className="mb-4 text-13 text-muted">
    <span className="tabular-nums">{active} of {capacity}</span> companies tracked
    {remaining > 0 ? <> · {remaining} {remaining === 1 ? "space" : "spaces"} left</> : " · no spaces left"}
    {remaining <= 5 && <> · <a href={atTechnicalLimit ? "/companies" : "/account#plan-and-credits"} className="underline">
      {atTechnicalLimit ? "Manage companies" : plan === "free" ? "Compare plans" : "Manage company capacity"}
    </a></>}
    <span className="block text-12">Paused and archived companies do not use a space.</span>
  </p>;
}
