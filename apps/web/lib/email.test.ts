/**
 * Without an email provider the log is the only place a link can go. A live reset link in a log is
 * an account takeover for anyone who can read it, and the reset form is public, so production logs
 * the text only when the operator asks for it.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendEmail } from "./email";

const mail = { to: "ada@example.com", subject: "Reset your AVA password", text: "https://ava.test/reset-password?token=secret-token" };

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("AUTH_EMAIL_LOG", "");
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const logged = () => [...info.mock.calls, ...warn.mock.calls].map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

it("keeps the link out of a production log unless AUTH_EMAIL_LOG=1, and warns that nothing was sent", async () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(await sendEmail(mail)).toEqual({ delivered: false });
  expect(logged()).toEqual([{ event: "email_not_configured", to: mail.to, subject: mail.subject }]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logged())).not.toContain("secret-token");

  info.mockClear();
  warn.mockClear();
  vi.stubEnv("AUTH_EMAIL_LOG", "1");
  await sendEmail(mail);
  expect(logged()).toEqual([{ event: "email_not_configured", to: mail.to, subject: mail.subject, text: mail.text }]);
});

it("logs the link outside production unless AUTH_EMAIL_LOG=0", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await sendEmail(mail);
  expect(logged()).toEqual([expect.objectContaining({ text: mail.text })]);
  info.mockClear();
  vi.stubEnv("AUTH_EMAIL_LOG", "0");
  await sendEmail(mail);
  expect(logged()).toEqual([{ event: "email_not_configured", to: mail.to, subject: mail.subject }]);
});

it("sends through the provider when one is configured, and logs nothing", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "AVA <ava@example.com>");
  const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  expect(await sendEmail(mail)).toEqual({ delivered: true });
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(logged()).toEqual([]);
});
