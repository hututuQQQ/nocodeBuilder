import type { ChatMessage as LlmChatMessage } from "../llm/types";
import type { AgentStepContext, ModificationContext } from "./types";

const MAX_OBSERVATION_CHARS = 16_000;

export function buildGenerateProjectMessages(
  projectName: string,
  userPrompt: string,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a senior frontend project generator.",
        "Generate a complete, runnable web project from the user's prompt.",
        "The project must use Next.js App Router, React, TypeScript, and Tailwind CSS.",
        "Return complete file contents, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Keep the project deployable on Vercel without extra manual file edits.",
        "Do not create .env, .env.local, or .env.example files unless the user explicitly asks for them.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package such as `@ai-sdk/deepseek` inside App Router route handlers.",
        "If the user does not ask for AI features, do not add AI SDK dependencies or API routes just for decoration.",
        "Use visible UI text in the user's language when the request language is clear.",
        "Make the first screen the actual website/app experience, not a marketing page for the builder.",
        "Use real layout, responsive CSS, and visual assets or CSS-driven visuals that make the site feel complete.",
        "",
        "The response shape must strictly match:",
        '{"type":"write_files","summary":"string","files":[{"path":"package.json","content":"string"}]}',
        "",
        "Required files:",
        "- package.json",
        "- app/layout.tsx",
        "- app/page.tsx",
        "- app/globals.css",
        "",
        "package.json requirements:",
        "- scripts.dev must run next dev",
        "- scripts.build must run next build",
        "- scripts.start must run next start",
        "- dependencies must include exactly: next 14.2.35, react 18.3.1, react-dom 18.3.1",
        "- devDependencies must include exactly: typescript 5.4.5, tailwindcss 3.4.17, postcss 8.4.49, autoprefixer 10.4.20, @types/node 20.14.11, @types/react 18.3.3, @types/react-dom 18.3.0",
        "- Dependency versions must be pinned exact strings. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        "",
        "Allowed paths:",
        "- Root config files: package.json, next.config.*, postcss.config.*, tailwind.config.*, tsconfig.json, vercel.json, middleware.ts",
        "- app/**",
        "- components/**",
        "- lib/**",
        "- data/**",
        "- public/** text assets such as .svg, .txt, .json, .md",
        "- Files must be text files: .ts, .tsx, .js, .jsx, .mjs, .cjs, .css, .json, .md, .txt, or .svg",
        "- Forbidden: node_modules, .next, dist, .env files, absolute paths, and ../ paths",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Generate a complete Next.js App Router project.",
          projectName,
          userPrompt,
        },
        null,
        2,
      ),
    },
  ];
}

export function buildModifyProjectMessages(
  context: ModificationContext,
  userRequest: string,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a frontend project modification agent.",
        "The current project is a generated Next.js App Router project.",
        "You can only modify frontend and App Router files inside the current project.",
        "You must return complete file contents based on the user request, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Do not delete important existing content unless the user asked for that.",
        "Keep the project runnable with npm run build.",
        "If the user asks for backend, database, auth, orders, or admin features, create frontend mock UI and mock data only unless the request explicitly asks for a Next.js route handler.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package such as `@ai-sdk/deepseek` inside App Router route handlers.",
        "If you add or remove dependencies, return a complete updated package.json.",
        "package.json must keep pinned exact dependency versions. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        "Keep the core versions exactly pinned as: next 14.2.35, react 18.3.1, react-dom 18.3.1, typescript 5.4.5, tailwindcss 3.4.17, postcss 8.4.49, autoprefixer 10.4.20, @types/node 20.14.11, @types/react 18.3.3, @types/react-dom 18.3.0.",
        "Do not create .env, .env.local, or .env.example files unless the user explicitly asks for them.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "Match the user's language for the response summary. If the user request is Chinese, write summary in Simplified Chinese.",
        "When adding or rewriting visible page copy, prefer the user's language unless the existing project clearly uses a different language or the user asks otherwise.",
        "",
        "The response shape must strictly match:",
        '{"type":"modify_files","summary":"string","files":[{"path":"app/page.tsx","content":"string"}]}',
        "",
        "Path restrictions:",
        "- You may modify package.json and root Next/Tailwind/TypeScript/Vercel config files",
        "- You may modify app/**",
        "- You may modify components/**",
        "- You may modify lib/**",
        "- You may modify data/**",
        "- You may modify public/** text assets such as .svg, .txt, .json, .md",
        "- Files must be text files: .ts, .tsx, .js, .jsx, .mjs, .cjs, .css, .json, .md, .txt, or .svg",
        "- Forbidden: node_modules, .next, dist, .env files, files outside the project, absolute paths, and ../ paths",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Modify the existing Next.js project according to the user request.",
          userRequest,
          projectContext: {
            recentMessages: context.recentMessages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            fileTree: context.fileTree,
            files: context.files,
          },
          instructions: [
            "Return only the files that need to be written.",
            "Each returned file must contain the complete final file content.",
            "Preserve useful existing code and content unless the user asked to replace it.",
            "Prefer React, TypeScript, Tailwind CSS, Next.js App Router, and lucide-react when available.",
            "The project must keep compiling after the change.",
            "Write the summary in the same language as userRequest.",
            "Use the same language as userRequest for newly created visible UI text when that is reasonable.",
          ],
        },
        null,
        2,
      ),
    },
  ];
}

export function buildAgentStepMessages(
  context: AgentStepContext,
  userRequest: string,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a careful project agent for a generated Next.js App Router app.",
        "You operate in a plan-act-observe loop. You may only act by returning one JSON object that matches the protocol.",
        "Do not claim that a tool succeeded until an observation says it succeeded.",
        "Choose exactly one next step. If you need information, call a read/list tool. If the task is complete, return finish.",
        "Use the smallest useful action. Preserve existing code and content unless the user asked to replace it.",
        "If the user asks a question that can be answered from current context, return answer without changing files.",
        "Before editing a file, inspect the relevant file unless a previous observation already includes its current content.",
        "When writing files, return complete final file contents, not diffs.",
        "After write_files or delete_files, the host app will run a build verification and report the result as an observation.",
        "If a build observation fails, use the error output to repair the project once with focused edits.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "Never create .env, .env.local, or .env.example files, and never put real secrets in generated files.",
        "If the user asks for backend, database, auth, orders, or admin features, create frontend mock UI and mock data only unless they explicitly ask for a Next.js route handler.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package such as `@ai-sdk/deepseek` inside App Router route handlers.",
        "If you modify package.json, keep pinned exact dependency versions. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        "Keep the core versions exactly pinned as: next 14.2.35, react 18.3.1, react-dom 18.3.1, typescript 5.4.5, tailwindcss 3.4.17, postcss 8.4.49, autoprefixer 10.4.20, @types/node 20.14.11, @types/react 18.3.3, @types/react-dom 18.3.0.",
        "Match the user's language for summaries and newly created visible UI text when reasonable.",
        "",
        "Available tools:",
        '- list_files args {}: inspect the project file tree.',
        '- read_files args {"paths":["app/page.tsx"]}: read text files.',
        '- write_files args {"summary":"string","files":[{"path":"app/page.tsx","content":"string"}]}: write complete file contents.',
        '- delete_files args {"summary":"string","paths":["components/Old.tsx"]}: delete files only when clearly needed.',
        '- run_command args {"command":"npm run build"}: run one allowed command. Allowed commands: npm install, npm run build, pnpm install, pnpm build.',
        '- start_dev_server args {}: start the local preview server.',
        '- stop_dev_server args {}: stop the local preview server.',
        '- refresh_preview args {}: refresh the preview iframe after a UI-only change.',
        '- rollback_last_change args {}: roll back the most recent agent file change.',
        "",
        "Allowed file paths:",
        "- Root config files: package.json, next.config.*, postcss.config.*, tailwind.config.*, tsconfig.json, vercel.json, middleware.ts",
        "- app/**",
        "- components/**",
        "- lib/**",
        "- data/**",
        "- public/** text assets such as .svg, .txt, .json, .md",
        "- Files must be text files: .ts, .tsx, .js, .jsx, .mjs, .cjs, .css, .json, .md, .txt, or .svg",
        "- Forbidden: node_modules, .next, dist, .env files, files outside the project, absolute paths, and ../ paths",
        "",
        "Response protocol:",
        '{"type":"answer","message":"string"}',
        '{"type":"tool_call","tool":"read_files","rationale":"string","args":{"paths":["app/page.tsx"]}}',
        '{"type":"finish","summary":"string","verification":"string"}',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Choose the next agent step for the user's request.",
          userRequest,
          projectState: {
            projectName: context.projectName,
            devServerStatus: context.devServerStatus,
            previewUrl: context.previewUrl,
            fileTree: context.fileTree,
          },
          recentMessages: context.recentMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          observations: context.observations.map((observation) => ({
            ...observation,
            content: observation.content
              ? truncateObservation(observation.content)
              : undefined,
          })),
          instructions: [
            "Return one next step only.",
            "Prefer answer when the user is asking for explanation or status.",
            "Prefer read_files before write_files when file contents are not already known.",
            "Use finish only after the request is handled or cannot proceed safely.",
            "Do not include Markdown fences. The response must be one JSON object.",
          ],
        },
        null,
        2,
      ),
    },
  ];
}

function truncateObservation(content: string) {
  if (content.length <= MAX_OBSERVATION_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_OBSERVATION_CHARS)}\n\n[Observation truncated for prompt size.]`;
}
