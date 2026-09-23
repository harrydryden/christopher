/**
 * An environment variable renamed with the product (formerly Christopher): the new `AVA_*` name
 * first, then the old `CHRISTOPHER_*` one, so a deployment whose dashboard still sets the old name
 * keeps working. An empty value counts as unset, as it always has for these variables.
 */
export function renamedEnv(
  env: Record<string, string | undefined>,
  name: `AVA_${string}`,
  legacyName: `CHRISTOPHER_${string}`,
): string | undefined {
  return env[name] || env[legacyName] || undefined;
}
