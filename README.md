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
