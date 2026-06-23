# AI Web Builder

Desktop AI web builder for generating, modifying, verifying, previewing, and manually deploying project-scoped Next.js sites from a Tauri 2 app.

## Stack

- Tauri 2
- React
- TypeScript
- Vite
- Tailwind CSS
- Zustand
- Rust host commands
- SQLite run/event storage

## What It Does

- Creates and selects local generated projects.
- Runs OpenAI-compatible model workflows for initial site generation and follow-up edits.
- Executes file, command, Supabase schema, preview, and deployment tools through host adapters.
- Tracks project conversations, change history, explicit accept/revert, command logs, and preview state.
- Stores persistent Agent runs, append-only events, verification reports, and artifacts in project metadata.
- Gates Agent completion on an external verifier report instead of model-only `finish` output.
- Maintains a lightweight Nocode Site IR (`SiteSpec` and source map) for stable page/node identity.
- Supports run pause, resume, cancel, steering, verification timeline, and preview node selection.

## Runtime Architecture

The app now separates the Agent into these layers:

- React UI: chat, run controls, event timeline, verification projection, preview selection.
- Agent application service: adapts UI state, chat streaming, existing project tools, and host commands.
- Headless TypeScript core: task contracts, run state machine, policy, tool metadata, verifier, and Site IR types.
- Tauri/Rust boundary: file paths, command whitelist, credentials, project metadata, SQLite persistence, and artifacts.

`src/store/agentWorkflow.ts` remains only as a compatibility entrypoint. The active orchestration lives in `src/agent-runtime/runController.ts` and uses `src/agent-core/**` for authoritative runtime decisions.

## Data Storage

Each generated project is stored under the local `AIBuilderProjects` workspace. Host-managed metadata lives in:

```text
.aibuilder/
  project.json
  agent.sqlite
  site-spec.json
  source-map.json
  artifacts/<run-id>/
```

Normal Agent file tools cannot write `.aibuilder/**`. SiteSpec, source map, runs, events, reports, and artifacts are updated through Tauri commands only.

Existing conversation JSON and change history remain compatible and are not migrated into SQLite.

## Scripts

```bash
npm install
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

## Managed Node Runtime

Packaged nocodeBuilder builds do not require the host machine to have Node.js installed before using project chat workflows. When `npm`, `pnpm`, or `npx` are not available on PATH, the desktop app downloads the latest Node.js LTS archive from nodejs.org, extracts it into a local app runtime directory, and uses that runtime for installs, builds, previews, and Vercel CLI calls.

Advanced overrides:

- `NOCODE_BUILDER_NODE_DIR`: use an existing Node.js installation directory instead of auto-downloading one.
- `NOCODE_BUILDER_RUNTIME_DIR`: choose where nocodeBuilder stores managed runtimes.

## Safety Boundaries

- Rust validates project ids and file paths.
- Agent file tools cannot write `.aibuilder`, `.env`, `node_modules`, build output, or paths outside the project.
- Command execution remains limited to the project command whitelist.
- Model requests can be cancelled through `AbortSignal`; late results are ignored after cancellation.
- Production deployment is never automatic and remains a manual Vercel action.
- Secret-like content is blocked before file writes.

## Tauri Prerequisites

`npm run tauri dev` requires Rust/Cargo and the Windows build prerequisites from Tauri to be installed on the machine.
