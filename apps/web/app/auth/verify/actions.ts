"use server";

import { redirect } from "next/navigation";
import { confirmEmailWithToken } from "@/lib/accounts";
import { clientAddress, getCurrentUser, startSessionFromProof } from "@/lib/auth";
import { withParams } from "@/lib/origin";
import { LIMITS, releaseRateLimitReservations, reserveRateLimits } from "@/lib/rate-limit";

/** The confirmation link is completed by a POST, so a mail scanner following the link cannot spend it. */
export async function confirmEmail(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").slice(0, 200);
  const password = String(formData.get("password") ?? "");
  const back = (error: string) => redirect(withParams("/auth/verify", { token, error }));
  const address = await clientAddress();
  const reservation = await reserveRateLimits([{ key: `verify:ip:${address}`, limit: LIMITS.loginAddress }]);
  if (!reservation) back("rate_limited");
  const current = await getCurrentUser();
  const result = await confirmEmailWithToken(token, { sessionUserId: current?.user.id ?? null, sessionId: current?.sessionId ?? null, password });
  if (result.status === "password") {
    back("password");
  }
  await releaseRateLimitReservations(reservation!);
  if (result.status !== "done") {
    back("invalid");
    return;
  }
  if (current?.user.id !== result.user.id) {
    if (!result.user.passwordHash || !(await startSessionFromProof({ userId: result.user.id,
      proof: { provider: "password", expectedPasswordHash: result.user.passwordHash } }))) back("invalid");
  }
  redirect("/account?verify=done");
}
