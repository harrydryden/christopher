import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
for (const flag of ["--output", "--posting-references"]) {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !isAbsolute(args[index + 1])) {
    args[index + 1] = resolve(repositoryRoot, args[index + 1]);
  }
}
// Run the checked-in TS entry directly: pnpm maps every non-zero nested `exec` result to 1,
// which would collapse the offline corpus command's distinct blocked (2) result.
const child = spawn(process.execPath, ["--import", "tsx", resolve(repositoryRoot, "apps/worker/src/live-acceptance-cli.ts"), ...args], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
child.on("exit", code => process.exitCode = code ?? 1);
