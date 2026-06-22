# AI Web Builder

Desktop MVP shell for a frontend-only AI Web Builder.

## Stack

- Tauri 2
- React
- TypeScript
- Vite
- Tailwind CSS
- Zustand

## Scripts

```bash
npm install
npm run build
npm run tauri dev
```

## Current Scope

This MVP only contains the desktop app shell:

- project sidebar
- chat workspace
- preview panel
- files/logs panel
- basic Zustand state

LLM integration, project generation, backend services, databases, deployment, multi-agent flows, spec coding, and drag/drop editing are intentionally out of scope for this task.

## Tauri Prerequisites

`npm run tauri dev` requires Rust/Cargo and the Windows build prerequisites from Tauri to be installed on the machine.

## Managed Node Runtime

Packaged nocodeBuilder builds do not require the host machine to have Node.js installed before using project chat workflows. When `npm`, `pnpm`, or `npx` are not available on PATH, the desktop app downloads the latest Node.js LTS archive from nodejs.org, extracts it into a local app runtime directory, and uses that runtime for installs, builds, previews, and Vercel CLI calls.

Advanced overrides:

- `NOCODE_BUILDER_NODE_DIR`: use an existing Node.js installation directory instead of auto-downloading one.
- `NOCODE_BUILDER_RUNTIME_DIR`: choose where nocodeBuilder stores managed runtimes.
