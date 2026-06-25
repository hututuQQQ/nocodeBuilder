import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SIDECARS = ["ncb-sandbox-setup", "ncb-sandbox-runner"];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const tauriDir = join(repoRoot, "src-tauri");
const args = process.argv.slice(2);
const release = args.includes("--release");
const targetArg = readArgValue("--target");
const targetTriple =
  targetArg ?? process.env.TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const profile = release ? "release" : "debug";
const extension = targetTriple.includes("windows") ? ".exe" : "";

const cargoArgs = [
  "build",
  "--manifest-path",
  join(tauriDir, "Cargo.toml"),
  "--bin",
  "ncb-sandbox-setup",
  "--bin",
  "ncb-sandbox-runner",
];

if (release) {
  cargoArgs.push("--release");
}

if (targetArg) {
  cargoArgs.push("--target", targetArg);
}

run("cargo", cargoArgs, repoRoot);

const artifactDir = targetArg
  ? join(tauriDir, "target", targetTriple, profile)
  : join(tauriDir, "target", profile);
const destinationDir = join(tauriDir, "binaries");
mkdirSync(destinationDir, { recursive: true });

for (const sidecar of SIDECARS) {
  const source = join(artifactDir, `${sidecar}${extension}`);
  const destination = join(destinationDir, `${sidecar}-${targetTriple}${extension}`);

  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`sidecar artifact was not built: ${source}`);
  }

  copyFileSync(source, destination);
  console.log(`prepared Tauri sidecar ${destination}`);
}

function readArgValue(name) {
  const index = args.indexOf(name);

  if (index === -1) {
    return null;
  }

  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.status !== 0) {
    throw new Error("failed to read rustc host triple");
  }

  const match = result.stdout.match(/^host:\s*(.+)$/m);

  if (!match) {
    throw new Error("rustc -vV did not include a host triple");
  }

  return match[1].trim();
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed`);
  }
}
