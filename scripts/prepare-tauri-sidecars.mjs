import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SIDECARS = ["ncb-sandbox-setup", "ncb-sandbox-runner"];
const SIDECAR_FEATURE = "sandbox-sidecars";

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
const sidecarTargetDir = join(tauriDir, "target", "sidecars");
const sidecarManifestDir = join(sidecarTargetDir, "manifest");
const sidecarManifestPath = writeSidecarManifest(sidecarManifestDir);

const cargoArgs = [
  "build",
  "--manifest-path",
  sidecarManifestPath,
  "--bin",
  "ncb-sandbox-setup",
  "--bin",
  "ncb-sandbox-runner",
  "--features",
  SIDECAR_FEATURE,
  "--target-dir",
  sidecarTargetDir,
];

if (release) {
  cargoArgs.push("--release");
}

if (targetArg) {
  cargoArgs.push("--target", targetArg);
}

run("cargo", cargoArgs, repoRoot);

const artifactDir = targetArg
  ? join(sidecarTargetDir, targetTriple, profile)
  : join(sidecarTargetDir, profile);
const appArtifactDir = targetArg
  ? join(tauriDir, "target", targetTriple, profile)
  : join(tauriDir, "target", profile);
const destinationDir = join(tauriDir, "binaries");
mkdirSync(destinationDir, { recursive: true });
removeStaleAppTargetSidecars(appArtifactDir);

for (const sidecar of SIDECARS) {
  const source = join(artifactDir, `${sidecar}${extension}`);
  const destination = join(destinationDir, `${sidecar}-${targetTriple}${extension}`);

  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`sidecar artifact was not built: ${source}`);
  }

  copyFileSync(source, destination);
  console.log(`prepared Tauri sidecar ${destination}`);

  if (targetTriple.includes("windows")) {
    const resourceDestination = join(destinationDir, `${sidecar}.exe`);
    copyFileSync(source, resourceDestination);
    console.log(`prepared Tauri sidecar resource ${resourceDestination}`);

    if (sidecar === "ncb-sandbox-runner") {
      mkdirSync(appArtifactDir, { recursive: true });
      const appTargetDestination = join(appArtifactDir, `${sidecar}.exe`);
      copyFileSync(source, appTargetDestination);
      console.log(`prepared Tauri app target runner ${appTargetDestination}`);
    }
  }
}

function removeStaleAppTargetSidecars(appArtifactDir) {
  for (const sidecar of SIDECARS) {
    for (const suffix of [extension, ".pdb"]) {
      const stalePath = join(appArtifactDir, `${sidecar}${suffix}`);
      if (!existsSync(stalePath)) {
        continue;
      }

      rmSync(stalePath, { force: true });
      console.log(`removed stale Tauri app target sidecar ${stalePath}`);
    }
  }
}

function writeSidecarManifest(manifestDir) {
  mkdirSync(manifestDir, { recursive: true });

  const mainCargoToml = readFileSync(join(tauriDir, "Cargo.toml"), "utf8");
  const dependencySections = extractDependencySections(mainCargoToml);
  const setupPath = cargoPath(
    relative(manifestDir, join(tauriDir, "src", "bin", "ncb-sandbox-setup.rs")),
  );
  const runnerPath = cargoPath(
    relative(manifestDir, join(tauriDir, "src", "bin", "ncb-sandbox-runner.rs")),
  );
  const manifestPath = join(manifestDir, "Cargo.toml");
  const manifest = `[package]
name = "ncb-sandbox-sidecars"
version = "0.1.0"
edition = "2021"
publish = false
autobins = false

[features]
${SIDECAR_FEATURE} = []

[[bin]]
name = "ncb-sandbox-setup"
path = "${setupPath}"

[[bin]]
name = "ncb-sandbox-runner"
path = "${runnerPath}"

${dependencySections}
`;

  writeFileSync(manifestPath, manifest);
  return manifestPath;
}

function extractDependencySections(cargoToml) {
  const sections = [];
  let current = null;

  for (const line of cargoToml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (current) {
        sections.push(current.join("\n").trimEnd());
      }

      current =
        trimmed === "[dependencies]" ||
        (trimmed.startsWith("[target.") && trimmed.endsWith(".dependencies]"))
          ? [line]
          : null;
      continue;
    }

    if (current) {
      current.push(line);
    }
  }

  if (current) {
    sections.push(current.join("\n").trimEnd());
  }

  if (sections.length === 0) {
    throw new Error("failed to extract dependency sections from src-tauri/Cargo.toml");
  }

  return sections.join("\n\n");
}

function cargoPath(path) {
  return path.replaceAll("\\", "/");
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
