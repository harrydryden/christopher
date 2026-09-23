import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const child = spawn("pnpm", ["--filter", "@ava/worker", "exec", "tsx", "src/capture-live-accuracy-snapshots.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk; });
const code = await new Promise(resolveExit => child.on("exit", resolveExit));
if (code !== 0) process.exit(code ?? 1);

const payloadStart = output.lastIndexOf('{"schemaVersion"');
if (payloadStart < 0) throw new Error("snapshot worker did not return its payload");
const payload = JSON.parse(output.slice(payloadStart));
const generatedSuffix = new Date(payload.generatedAt).toISOString().replace(/[:.]/g, "-");
const directory = resolve(root, valueAfter("--output") ?? `docs/live-snapshots/${generatedSuffix}`);
if (!args.includes("--overwrite")) {
  await access(directory).then(
    () => { throw new Error(`${directory} already exists; choose --output or pass --overwrite explicitly`); },
    () => undefined,
  );
}
await mkdir(directory, { recursive: true });
for (const snapshot of payload.snapshots) {
  const body = Buffer.from(snapshot.bodyBase64, "base64");
  await writeFile(resolve(directory, `${snapshot.id}.html`), body);
  snapshot.bytes = body.byteLength;
  snapshot.sha256 = createHash("sha256").update(body).digest("hex");
  delete snapshot.bodyBase64;
}
await writeFile(resolve(directory, "independent-oracle.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${directory}\n`);
