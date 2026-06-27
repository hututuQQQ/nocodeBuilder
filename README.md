# nocodeBuilder

nocodeBuilder 是一个本地优先的桌面无代码构建器。它把“提出需求、生成 Spec、执行代码变更、预览、审查、连接 Supabase、部署到 Vercel”放在同一个 Tauri 桌面应用里，帮助用户用自然语言迭代生成项目级的 Next.js 网站和应用。

nocodeBuilder is a local-first desktop no-code builder. It brings prompt-to-spec planning, code generation, preview, review, Supabase management, and Vercel deployment into one Tauri desktop app for iterating on project-scoped Next.js sites and apps.

## 中文

### nocodeBuilder 是什么

nocodeBuilder 面向想用 AI 快速搭建前端项目、但仍希望保留本地文件、审查权和部署控制权的用户。它不是一次性网页生成器，而是一个可持续迭代的桌面工作台：每个项目都有自己的对话、Spec、Agent 运行记录、文件树、预览状态和变更审查。

### 核心工作流

1. 创建本地项目，描述你要构建的网站或应用。
2. 在 Spec 模式下生成需求、设计和任务，确认后再执行代码。
3. Agent 按任务修改项目文件，运行安装、构建、验证和预览相关命令。
4. 在预览区查看本地运行效果，并可选中预览节点辅助定位。
5. 在文件、日志和 Review 面板中检查变更，按文件或整体接受/还原。
6. 配置 Supabase 或 Vercel 后，继续管理数据库表、行数据和部署预览。

### 关键能力

- Chat 与 Spec 两种迭代模式：快速修改或先规划再执行。
- 三栏桌面工具界面：项目/对话、构建过程、预览与文件审查同时可见。
- Agent Run 时间线：支持暂停、恢复、取消、追加指令、审批和验证报告。
- 本地文件审查：查看生成文件、读取日志、接受或还原代码变更。
- 预览桥接：本地预览可把选中的页面节点反馈给构建器。
- 数据库面板：读取 Supabase 表结构和行数据，支持创建表、编辑列、增删改行。
- Vercel 集成：保存 token、检测项目、创建预览部署，生产部署保持手动边界。
- 中英文界面：默认跟随系统语言，也可在设置和侧边栏手动切换。

### AI 服务商配置

首次启动时需要配置 AI 服务商、API Key、Base URL 和模型。当前界面支持 DeepSeek、GLM 和 OpenAI 兼容配置。API Key 存放在系统凭据管理器中，模型选择和界面语言等普通设置存放在应用本地存储中。

### 本地项目与存储模型

生成的项目存放在本机工作区中。为了兼容历史版本，内部工作区目录仍使用 `AIBuilderProjects`，应用存储目录仍使用 `AIWebBuilder`，凭据服务名仍使用 `AI Web Builder`。

每个项目的宿主元数据位于：

```text
.aibuilder/
  project.json
  agent.sqlite
  site-spec.json
  source-map.json
  artifacts/<run-id>/
```

普通 Agent 文件工具不能写入 `.aibuilder/**`。SiteSpec、source map、运行记录、事件、报告和 artifacts 只能通过 Tauri 命令更新。

### Supabase 与 Vercel

Supabase 配置保存在项目 `.env` 中：公开 anon key 用于生成的应用，secret key 用于数据库面板读取和写入行数据，`SUPABASE_DB_URL` 用于创建表和修改 schema。进行 schema 变更时建议使用 Supabase Connection Pooler 的 Session mode。

Vercel 配置用于手动创建预览部署。nocodeBuilder 不会自动执行生产部署，生产发布仍需要用户明确操作。

### 托管 Node 运行时

打包后的 nocodeBuilder 不要求主机预先安装 Node.js。当 `npm`、`pnpm` 或 `npx` 不在 PATH 中时，应用会下载最新 Node.js LTS，解压到本地运行时目录，并用于依赖安装、构建、预览和 Vercel CLI。

高级覆盖：

- `NOCODE_BUILDER_NODE_DIR`：使用已有 Node.js 安装目录。
- `NOCODE_BUILDER_RUNTIME_DIR`：指定托管运行时的存放目录。

### 安全边界

- Rust 层校验 project id 和文件路径。
- Agent 文件工具不能写入 `.aibuilder`、`.env`、`node_modules`、构建输出或项目外路径。
- 命令执行限制在项目命令白名单内。
- 生产部署不会自动触发。
- 写文件前会阻止疑似 secret 内容。
- 取消请求后，迟到的模型结果会被忽略。

### 开发命令

```bash
npm install
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

## English

### What nocodeBuilder Is

nocodeBuilder is for people who want AI-assisted app building without giving up local files, review control, or deployment boundaries. It is not a one-shot page generator. It is a persistent desktop workspace where every project keeps its own conversations, specs, Agent runs, file tree, preview state, logs, and review history.

### Core Workflow

1. Create a local project and describe the site or app you want.
2. Use Spec mode to generate requirements, design, and implementation tasks before code is written.
3. Let the Agent modify project files and run allowed install, build, verification, and preview commands.
4. Inspect the generated app in the preview pane, including preview node selection.
5. Review files, logs, and diffs, then accept or revert changes at the file or project level.
6. Connect Supabase or Vercel when you want database management or preview deployment.

### Key Features

- Chat and Spec iteration modes for fast edits or planned execution.
- Dense three-panel desktop layout for projects, Agent activity, preview, files, logs, and review.
- Agent Run timeline with pause, resume, cancel, steering, approvals, artifacts, and verification reports.
- Local file review with accept/revert controls.
- Preview bridge that reports selected UI nodes back to the builder.
- Supabase dashboard for table discovery, row editing, table creation, and column edits.
- Vercel preview deployment with explicit user control.
- English and Simplified Chinese UI with System language detection and persisted manual override.

### AI Provider Setup

On first launch, configure an AI provider, API key, Base URL, and models. The UI supports DeepSeek, GLM, and OpenAI-compatible provider settings. API keys are stored in the system credential manager. Non-secret preferences, including model selection and UI language, are stored in local app storage.

### Local Project and Storage Model

Generated projects live in a local workspace. For backward compatibility, internal storage names remain unchanged: the workspace directory is `AIBuilderProjects`, the app storage directory is `AIWebBuilder`, and the credential service name is `AI Web Builder`.

Host-managed project metadata lives in:

```text
.aibuilder/
  project.json
  agent.sqlite
  site-spec.json
  source-map.json
  artifacts/<run-id>/
```

Normal Agent file tools cannot write `.aibuilder/**`. SiteSpec, source maps, runs, events, reports, and artifacts are updated only through Tauri commands.

### Supabase and Vercel

Supabase settings are stored in the project `.env`: the public anon key is for generated apps, the secret key is for the database panel, and `SUPABASE_DB_URL` is used for schema changes. For schema changes, Supabase Connection Pooler Session mode is recommended.

Vercel integration is used for manual preview deployments. nocodeBuilder does not automatically deploy to production.

### Managed Node Runtime

Packaged nocodeBuilder builds do not require Node.js to be installed ahead of time. If `npm`, `pnpm`, or `npx` are unavailable on PATH, the app downloads the latest Node.js LTS archive, extracts it to a local runtime directory, and uses it for installs, builds, previews, and Vercel CLI calls.

Advanced overrides:

- `NOCODE_BUILDER_NODE_DIR`: use an existing Node.js installation directory.
- `NOCODE_BUILDER_RUNTIME_DIR`: choose where managed runtimes are stored.

### Safety Boundaries

- Rust validates project ids and file paths.
- Agent file tools cannot write `.aibuilder`, `.env`, `node_modules`, build output, or paths outside the project.
- Command execution is limited to the project command whitelist.
- Production deployment is never automatic.
- Secret-like content is blocked before file writes.
- Late model results are ignored after cancellation.

### Developer Commands

```bash
npm install
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```
