import type { GateSettings } from "@ava/core";
import { saveGate } from "@/app/actions/settings";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass } from "@/components/Field";
import { GATE_EXAMPLE, GATE_SENTENCE } from "@/lib/setup";

const textareaClass = `resize-y ${inputClass}`;
const fieldClass = "flex flex-col gap-1.5 text-14";

/**
 * The three gate fields in one block, so filters can be chosen wherever the person meets them
 * first. It saves the whole `gate` key through one action, which is what marks the checklist's
 * filter step done; an account that has never chosen sees the example rather than a word nobody
 * picked (Journey 1.2).
 */
export function GateSetup({
  gate,
  chosen,
  title = "Keywords and locations",
  id,
}: {
  /** The stored gate, or null where there is nothing to prefill. */
  gate: GateSettings | null;
  /** Whether these filters have ever been saved. Unchosen fields start empty, not prefilled. */
  chosen: boolean;
  title?: string;
  id?: string;
}) {
  const stored = chosen ? gate : null;
  return (
    <div id={id}>
      <Card title={title}>
        <p className="mb-3 text-14 text-muted">{GATE_SENTENCE}</p>
        <SettingsForm action={saveGate} submitLabel={chosen ? "Save" : "Save filters"}>
          <label className={fieldClass}>
            <span className={labelClass}>Include keywords</span>
            <textarea
              name="includeKeywords"
              rows={2}
              defaultValue={stored ? stored.includeKeywords.join("\n") : ""}
              placeholder={GATE_EXAMPLE}
              className={textareaClass}
            />
            <span className="text-12 text-muted">
              One per line or comma-separated, whole words in the title. <code>operat*</code> matches Operations and Operational; quote a phrase to match it exactly.
            </span>
          </label>
          <label className={fieldClass}>
            <span className={labelClass}>Exclude keywords</span>
            <textarea
              name="excludeKeywords"
              rows={2}
              defaultValue={stored ? stored.excludeKeywords.join("\n") : ""}
              placeholder="e.g. intern, graduate"
              className={textareaClass}
            />
            <span className="text-12 text-muted">Any match here keeps a role out, whatever else it matched.</span>
          </label>
          <label className={fieldClass}>
            <span className={labelClass}>Locations</span>
            <textarea
              name="locationTerms"
              rows={2}
              defaultValue={stored ? stored.locationTerms.join("\n") : ""}
              placeholder="e.g. London, UK"
              className={textareaClass}
            />
            <span className="text-12 text-muted">A country admits its cities. Leave empty to accept every location.</span>
          </label>
          <label className="flex items-center gap-2 text-14">
            <input type="checkbox" name="includeRemote" value="1" defaultChecked={stored ? stored.includeRemote : true} className="h-4 w-4" />
            Include remote roles
          </label>
        </SettingsForm>
      </Card>
    </div>
  );
}
