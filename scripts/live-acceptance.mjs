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
const child = spawn("pnpm", ["--filter", "@ava/worker", "exec", "tsx", "src/live-acceptance-cli.ts", ...args], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
child.on("exit", code => process.exitCode = code ?? 1);
