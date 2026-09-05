/**
 * Print a scrypt hash for APP_PASSWORD_HASH.
 * Usage: pnpm --filter @christopher/web hash-password 'your password'
 *     or: npx tsx scripts/hash-password.ts 'your password'
 */
import { hashPassword } from "../lib/password";

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("Usage: tsx scripts/hash-password.ts <password>");
    process.exitCode = 1;
    return;
  }
  const hash = await hashPassword(password);
  console.log(hash);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
