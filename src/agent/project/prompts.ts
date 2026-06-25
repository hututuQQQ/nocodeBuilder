import type { ChatMessage as LlmChatMessage } from "../llm/types";
import { formatUserLanguageInstruction } from "../languagePolicy";
import {
  DEFAULT_PROJECT_POLICY,
  formatAllowedPathsForPrompt,
  formatCorePackageVersionRule,
  formatPackageJsonRequirementsForPrompt,
  formatRequiredFilesForPrompt,
  type ProjectPolicy,
} from "./projectPolicy";
import type { AgentStepContext, ModificationContext } from "./types";
import { formatAgentToolListForPrompt } from "./toolRegistry";

const MAX_OBSERVATION_CHARS = 16_000;

export function buildGenerateProjectMessages(
  projectName: string,
  userPrompt: string,
  backendContext?: AgentStepContext["backend"],
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        policy.generatorRole,
        "Generate a complete, runnable web project from the user's prompt.",
        policy.stackRequirement,
        "Return complete file contents, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Keep the project deployable on Vercel without extra manual file edits.",
        "Do not create .env, .env.local, or .env.example files unless the user explicitly asks for them.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "If the user asks for backend, database, CRUD, auth, orders, admin, or persisted data, build a real full-stack implementation when backendContext exists and backendContext.supabase.configured is true.",
        "For Supabase-backed features, use Next.js App Router route handlers under app/api/**/route.ts or server-only modules under lib/**. Browser/client components must not read SUPABASE_SECRET_KEY directly.",
        "Use the Supabase env variable names from backendContext. Reference process.env.NEXT_PUBLIC_SUPABASE_URL and process.env.SUPABASE_SECRET_KEY in server code; do not hard-code values.",
        "If Supabase is not configured, make the app ready for backend wiring with clear server-side placeholders and avoid pretending mock data is persisted.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package inside App Router route handlers.",
        "If the user does not ask for AI features, do not add AI SDK dependencies or API routes just for decoration.",
        "If you need a dependency, add it to package.json with an exact pinned version. Never run install commands with package names.",
        ...formatUserLanguageInstruction(
          "The JSON summary and newly created visible UI text",
        ),
        "Make the first screen the actual website/app experience, not a marketing page for the builder.",
        "Use real layout, responsive CSS, and visual assets or CSS-driven visuals that make the site feel complete.",
        "",
        "The response shape must strictly match:",
        '{"type":"write_files","summary":"string","files":[{"path":"package.json","content":"string"}]}',
        "",
        ...formatRequiredFilesForPrompt(policy),
        "",
        ...formatPackageJsonRequirementsForPrompt(policy),
        "- Extra dependencies are allowed only when the feature needs them. Prefer native fetch for Supabase REST route handlers to avoid unnecessary dependencies.",
        "",
        ...formatAllowedPathsForPrompt("Allowed paths:", policy),
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: policy.generationTask,
          backendContext: backendContext ?? null,
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
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        policy.modifierRole,
        `The current project is a generated ${policy.label} project.`,
        "You can modify frontend, App Router route handlers, server-only lib files, and project text assets inside the current project.",
        "You must return complete file contents based on the user request, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Do not delete important existing content unless the user asked for that.",
        "Keep the project runnable with npm run build.",
        "If the user asks for backend, database, CRUD, auth, orders, admin, or persisted data, build a real full-stack implementation when projectContext.backend.supabase.configured is true.",
        "For Supabase-backed features, use Next.js App Router route handlers under app/api/**/route.ts or server-only modules under lib/**. Browser/client components must not read SUPABASE_SECRET_KEY directly.",
        "Use the Supabase env variable names from projectContext.backend. Reference process.env.NEXT_PUBLIC_SUPABASE_URL and process.env.SUPABASE_SECRET_KEY in server code; do not hard-code values.",
        "If Supabase is not configured, make the app ready for backend wiring with clear server-side placeholders and avoid pretending mock data is persisted.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package inside App Router route handlers.",
        "If you add or remove dependencies, return a complete updated package.json.",
        "If you need a dependency, add it to package.json with an exact pinned version. Never run install commands with package names.",
        "package.json must keep pinned exact dependency versions. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        formatCorePackageVersionRule(policy),
        "Do not create .env, .env.local, or .env.example files unless the user explicitly asks for them.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        ...formatUserLanguageInstruction(
          "The JSON summary and newly added or rewritten visible page copy",
        ),
        "",
        "The response shape must strictly match:",
        '{"type":"modify_files","summary":"string","files":[{"path":"app/page.tsx","content":"string"}]}',
        "",
        ...formatAllowedPathsForPrompt("Path restrictions:", policy),
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: policy.modificationTask,
          userRequest,
          projectContext: {
            backend: context.backend ?? null,
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
            policy.preferredStackInstruction,
            "The project must keep compiling after the change.",
            ...formatUserLanguageInstruction(
              "The summary and newly created visible UI text",
            ),
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
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        policy.agentRole,
        "You operate in a plan-act-observe loop. You may only act by returning one JSON object that matches the protocol.",
        "Do not claim that a tool succeeded until an observation says it succeeded.",
        "Choose the smallest useful next step. If you need information, call read/list/search tools. If the task appears complete, return finish_candidate for external verification.",
        "You may return tool_calls with multiple calls only when every call is read-only, such as list_files, read_files, grep_files, or glob_files.",
        "Never include write_files, edit_file, delete_files, run_command, apply_supabase_schema, preview, or dev-server tools inside tool_calls. Return exactly one tool_call for any write, command, schema, preview, or dev-server action.",
        "Do not combine file edits, deletes, commands, schema changes, or refresh with other tool calls.",
        "Use the smallest useful action. Preserve existing code and content unless the user asked to replace it.",
        "If the user asks a question that can be answered from current context, return answer without changing files.",
        "If the user reports a bug, build error, runtime error, broken preview, failed command, or asks to fix/change project behavior, use tools to inspect diagnostics and relevant files before answering.",
        "Before editing, deleting, or overwriting an existing file, inspect the relevant file with read_files in this run.",
        "Prefer grep_files or glob_files to locate code before reading large files.",
        "Prefer edit_file for focused changes. Use write_files for new files or deliberate full-file rewrites.",
        "When using edit_file, old_string must be exact text copied from a read_files observation.",
        "After edit_file, write_files, or delete_files, the host app will verify the project and report the result as an observation.",
        "Do not start or refresh the preview unless the user explicitly asks to preview, run, or open the app.",
        "If a verification observation fails, use the structured error output to repair the project with focused edits.",
        "Treat steering as additional runtime guidance and constraints. Steering can narrow choices but never expands task permissions, allowed paths, database access, or deployment authority.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "Never create .env, .env.local, or .env.example files, and never put real secrets in generated files.",
        "If the user asks for backend, database, CRUD, auth, orders, admin, or persisted data, build a real full-stack implementation when backendContext.supabase.configured is true.",
        "For Supabase-backed features, use Next.js App Router route handlers under app/api/**/route.ts or server-only modules under lib/**. Browser/client components must not read SUPABASE_SECRET_KEY directly.",
        "Use the Supabase env variable names from backendContext. Reference process.env.NEXT_PUBLIC_SUPABASE_URL and process.env.SUPABASE_SECRET_KEY in server code; do not hard-code values.",
        "If database tables or columns are needed and backendContext.supabase.status.dbUrlConfigured is true, use apply_supabase_schema before writing API code that depends on those tables.",
        "apply_supabase_schema is non-destructive: it creates missing tables and adds missing columns only. Do not use it for deletes, renames, type changes, or data migrations.",
        "If Supabase is not configured, make the app ready for backend wiring with clear server-side placeholders and avoid pretending mock data is persisted.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package inside App Router route handlers.",
        "If you modify package.json, keep pinned exact dependency versions. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        formatCorePackageVersionRule(policy),
        "Never run npm install, pnpm install, npm add, pnpm add, or similar commands with package names. To add packages, edit package.json; the host automatically installs after package.json changes.",
        "Prefer native fetch for Supabase REST route handlers to avoid unnecessary dependencies. Add dependencies only when truly needed.",
        ...formatUserLanguageInstruction(
          "Answer messages, finish_candidate summaries, tool rationales/summaries, and newly created visible UI text",
        ),
        "",
        "Available tools:",
        formatAgentToolListForPrompt(),
        "",
        ...formatAllowedPathsForPrompt("Allowed file paths:", policy),
        "",
        "Response protocol:",
        '{"type":"answer","message":"string"}',
        '{"type":"tool_call","tool":"read_files","rationale":"string","args":{"paths":["app/page.tsx"]}}',
        '{"type":"tool_calls","rationale":"string","calls":[{"type":"tool_call","tool":"grep_files","rationale":"string","args":{"query":"Header","paths":["app","components"]}},{"type":"tool_call","tool":"glob_files","rationale":"string","args":{"pattern":"components/**/*.tsx"}}]}',
        '{"type":"tool_call","tool":"edit_file","rationale":"string","args":{"path":"app/page.tsx","old_string":"exact old text","new_string":"exact new text","summary":"string"}}',
        '{"type":"tool_call","tool":"apply_supabase_schema","rationale":"string","args":{"summary":"Created backend tables","tables":[{"name":"orders","enableRls":true,"columns":[{"name":"id","dataType":"uuid","defaultValue":"gen_random_uuid()","nullable":false,"primaryKey":true,"unique":false}]}]}}',
        '{"type":"finish_candidate","summary":"string","verification":"string"}',
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
            diagnostics: context.diagnostics,
          },
          backendContext: context.backend,
          projectMemory: context.memory,
          steering: context.steering,
          workingSummary: context.workingSummary,
          taskLedger: context.taskLedger,
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
            "Return one next step only, or a tool_calls batch containing only read-only calls.",
            "If using write_files, edit_file, delete_files, run_command, apply_supabase_schema, refresh_preview, start_dev_server, or stop_dev_server, return a single tool_call object, not tool_calls.",
            "Prefer answer only when the user is asking for explanation or status and not asking you to inspect or change the project.",
            "For bug, error, broken preview, or fix requests, do not return answer as the first step. Inspect files, search code, or run an allowed verification command first.",
            "Prefer grep_files or glob_files before reading when you need to locate code.",
            "Prefer read_files before edit_file, write_files, or delete_files when file contents are not already known from this run.",
            "Prefer edit_file over write_files for focused edits to existing files.",
            "Use finish_candidate only after the request is handled or cannot proceed safely. The external verifier decides whether the run completes.",
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
