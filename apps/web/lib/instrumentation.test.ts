/** apps/web/instrumentation.ts: tracing registers only when the deployment opts in, on Node. */
import { afterEach, describe, expect, it, vi } from "vitest";

const registerOTel = vi.hoisted(() => vi.fn());
vi.mock("@vercel/otel", () => ({ registerOTel }));

import { otelEnabled, register } from "@/instrumentation";

describe("instrumentation", () => {
  afterEach(() => { vi.unstubAllEnvs(); registerOTel.mockClear(); });

  it("is off by default, and off when OTEL_SDK_DISABLED is true or there is no endpoint", async () => {
    expect(otelEnabled({})).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: "false" })).toBe(false);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    await register();
    expect(registerOTel).not.toHaveBeenCalled();
  });

  it("registers col-web with a trace-id ratio sampler at 10 % when enabled on Node, and never on the edge", async () => {
    vi.stubEnv("OTEL_SDK_DISABLED", "false");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    vi.stubEnv("OTEL_TRACES_SAMPLER_ARG", undefined as unknown as string);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(registerOTel).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    expect(registerOTel).toHaveBeenCalledWith({ serviceName: "col-web", traceSampler: "traceidratio" });
    expect(process.env.OTEL_TRACES_SAMPLER_ARG).toBe("0.1");
  });
});
