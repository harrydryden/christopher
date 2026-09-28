/**
 * Small pieces the server actions share. Deliberately not a "use server" module: an export there is
 * a public endpoint, and these are only ever called by an action that has already authenticated.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/** Revalidate each of these pages. The list stays explicit per action; nothing revalidates everything. */
export function revalidate(...paths: string[]): void {
  for (const path of paths) revalidatePath(path);
}

/**
 * Back to a page with a refusal it reads out (`?error=`). A page that binds its form straight to an
 * action gets an expected refusal — a stale page, an empty or overlong answer — as a sentence,
 * rather than a crash page that loses what was typed.
 */
export function refuseOn(path: string, sentence: string): never {
  redirect(`${path}?${new URLSearchParams({ error: sentence }).toString()}`);
}
