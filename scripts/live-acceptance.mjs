import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex >= 0 && args[outputIndex + 1] && !isAbsolute(args[outputIndex + 1])) {
  args[outputIndex + 1] = resolve(repositoryRoot, args[outputIndex + 1]);
}
const child = spawn("pnpm", ["--filter", "@ava/worker", "exec", "tsx", "src/live-acceptance-cli.ts", ...args], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
child.on("exit", code => process.exitCode = code ?? 1);
