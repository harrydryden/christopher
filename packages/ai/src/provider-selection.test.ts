import { afterEach, expect, it, vi } from "vitest";
import { createAiEngine, createProviderClient, type AiClientLike } from "./engine";
import { assertSupportedProvider } from "./provider-selection";

afterEach(() => vi.unstubAllEnvs());

it("preserves the existing default and accepts an explicit Anthropic selection", () => {
  vi.stubEnv("AI_PROVIDER", undefined);
  expect(() => assertSupportedProvider()).not.toThrow();
  expect(() => assertSupportedProvider(" Anthropic ")).not.toThrow();
});

it.each(["munito", "unknown", "", "   "])("blocks %j before constructing a model client", provider => {
  vi.stubEnv("AI_PROVIDER", provider);
  expect(() => createAiEngine({ apiKey: "test-only", getModel: () => "claude-haiku-4-5" })).toThrow(/AI_PROVIDER is unsupported/);
  expect(() => createProviderClient("test-only")).toThrow(/AI_PROVIDER is unsupported/);
});

it("allows an explicitly injected fixture client without selecting a live adapter", () => {
  vi.stubEnv("AI_PROVIDER", "munito");
  const client = { messages: { create: vi.fn(), stream: vi.fn() } } as unknown as AiClientLike;
  expect(createAiEngine({ client, getModel: () => "fixture" }).enabled).toBe(true);
  expect(client.messages.create).not.toHaveBeenCalled();
  expect(client.messages.stream).not.toHaveBeenCalled();
});
