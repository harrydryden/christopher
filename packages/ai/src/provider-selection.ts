/** Only the implemented adapter may be selected; a new name must never fall back to Claude. */
export function assertSupportedProvider(provider = process.env.AI_PROVIDER): void {
  if (provider === undefined || provider.trim().toLowerCase() === "anthropic") return;
  throw new Error("AI_PROVIDER is unsupported. Only anthropic is implemented; selecting Munito requires a qualified adapter before model calls can run.");
}
