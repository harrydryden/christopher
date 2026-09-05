"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, readPasswordConfig } from "@/lib/password";
import { isLoginRateLimited, recordLoginFailure, resetLoginFailures } from "@/lib/rate-limit";
import { createSessionCookieValue, isSecureHost, sanitizeNextPath, SESSION_COOKIE_NAME, DEFAULT_SESSION_TTL_SECONDS } from "@/lib/session";

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  const config = readPasswordConfig();
  const secret = process.env.SESSION_SECRET;

  const loginUrl = (error: string) => {
    const url = new URL("/login", "http://internal");
    url.searchParams.set("error", error);
    if (next !== "/") url.searchParams.set("next", next);
    return `${url.pathname}${url.search}`;
  };

  if (config.kind === "malformed") {
    redirect(loginUrl("malformed_hash"));
  }
  if (config.kind === "missing" || !secret) {
    redirect(loginUrl("not_configured"));
  }
  if (isLoginRateLimited()) {
    redirect(loginUrl("rate_limited"));
  }

  const valid = await checkPassword(password, config);
  if (!valid) {
    recordLoginFailure();
    redirect(loginUrl("invalid"));
  }
  resetLoginFailures();

  const value = await createSessionCookieValue(secret, DEFAULT_SESSION_TTL_SECONDS);
  const host = (await headers()).get("host");
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureHost(host),
    maxAge: DEFAULT_SESSION_TTL_SECONDS,
  });

  redirect(next);
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE_NAME);
  redirect("/login");
}
