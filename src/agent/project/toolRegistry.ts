import type { AgentCommand, AgentToolCallStep } from "./types";

export type AgentToolName = AgentToolCallStep["tool"];

export type AgentToolDefinition = {
  argsDescription: string;
  description: string;
  isConcurrencySafe: boolean;
  isReadOnly: boolean;
  name: AgentToolName;
  needsVerification: boolean;
};

export const AGENT_COMMANDS: AgentCommand[] = [
  "npm install",
  "npm run build",
  "npm run lint",
  "npm run test",
  "npm test",
  "pnpm install",
  "pnpm build",
  "pnpm lint",
  "pnpm test",
];

export const AGENT_TOOL_DEFINITIONS = [
  {
    argsDescription: "{}",
    description: "Inspect the project file tree.",
    isConcurrencySafe: true,
    isReadOnly: true,
    name: "list_files",
    needsVerification: false,
  },
  {
    argsDescription:
      '{"paths":["app/page.tsx"],"offset":1,"limit":240}',
    description:
      "Read text files with optional 1-based line offset and line limit. Use before editing existing files.",
    isConcurrencySafe: true,
    isReadOnly: true,
    name: "read_files",
    needsVerification: false,
  },
  {
    argsDescription:
      '{"query":"Button","paths":["app","components"],"maxResults":40,"contextLines":1}',
    description:
      "Search allowed project files for text. Returns path, line number, and matching context.",
    isConcurrencySafe: true,
    isReadOnly: true,
    name: "grep_files",
    needsVerification: false,
  },
  {
    argsDescription: '{"pattern":"components/**/*.tsx","maxResults":80}',
    description: "Find allowed project files by glob pattern.",
    isConcurrencySafe: true,
    isReadOnly: true,
    name: "glob_files",
    needsVerification: false,
  },
  {
    argsDescription:
      '{"path":"app/page.tsx","old_string":"old exact text","new_string":"new exact text","summary":"Updated hero copy"}',
    description:
      "Make a focused text replacement in a previously read file. old_string must match exactly and be unique unless replace_all is true.",
    isConcurrencySafe: false,
    isReadOnly: false,
    name: "edit_file",
    needsVerification: true,
  },
  {
    argsDescription:
      '{"summary":"Updated project files","files":[{"path":"app/page.tsx","content":"complete final content"}]}',
    description:
      "Create files or overwrite complete file contents. Existing files must have been read first.",
    isConcurrencySafe: false,
    isReadOnly: false,
    name: "write_files",
    needsVerification: true,
  },
  {
    argsDescription: '{"summary":"Removed obsolete files","paths":["components/Old.tsx"]}',
    description:
      "Delete files only when clearly needed. Existing files must have been read first.",
    isConcurrencySafe: false,
    isReadOnly: false,
    name: "delete_files",
    needsVerification: true,
  },
  {
    argsDescription: '{"command":"npm run build"}',
    description: `Run one allowed command. Allowed commands: ${AGENT_COMMANDS.join(", ")}.`,
    isConcurrencySafe: false,
    isReadOnly: false,
    name: "run_command",
    needsVerification: false,
  },
  {
    argsDescription: "{}",
    description: "Start the local preview server.",
    isConcurrencySafe: false,
    isReadOnly: false,
    name: "start_dev_server",
    needsVerification: false,
  },
  {
    argsDescription: "{}",
    description: "Stop the local preview server.",
    isConcurrencySafe: false,
    isReadOnly: false,
    name: "stop_dev_server",
    needsVerification: false,
  },
  {
    argsDescription: "{}",
    description: "Refresh the preview iframe after a UI-only change.",
    isConcurrencySafe: true,
    isReadOnly: false,
    name: "refresh_preview",
    needsVerification: false,
  },
] satisfies AgentToolDefinition[];

export const AGENT_TOOL_NAMES = new Set<AgentToolName>(
  AGENT_TOOL_DEFINITIONS.map((tool) => tool.name),
);

export function getAgentToolDefinition(name: AgentToolName) {
  return AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

export function formatAgentToolListForPrompt() {
  return AGENT_TOOL_DEFINITIONS.map(
    (tool) =>
      `- ${tool.name} args ${tool.argsDescription}: ${tool.description}`,
  ).join("\n");
}

export function isAgentToolName(value: string): value is AgentToolName {
  return AGENT_TOOL_NAMES.has(value as AgentToolName);
}
