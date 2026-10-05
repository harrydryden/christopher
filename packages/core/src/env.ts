/**
 * An environment variable renamed with the product (Course of Life, formerly AVA, before that
 * Christopher): the new `COL_*` name first, then the `AVA_*` one, then the original
 * `CHRISTOPHER_*` one where the variable had one, so a deployment whose dashboard still sets an
 * old name keeps working. Returns the first non-empty value; an empty value counts as unset, as it
 * always has for these variables.
 */
export function renamedEnv(
  env: Record<string, string | undefined>,
  name: `COL_${string}`,
  legacyName: `AVA_${string}`,
  originalName?: `CHRISTOPHER_${string}`,
): string | undefined {
  return env[name] || env[legacyName] || (originalName ? env[originalName] : undefined) || undefined;
}
