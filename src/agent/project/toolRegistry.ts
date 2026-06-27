import {
  CORE_TOOL_DEFINITIONS,
  type CoreToolName,
} from "../../agent-core/tools/toolRegistry";
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

export const AGENT_TOOL_DEFINITIONS = CORE_TOOL_DEFINITIONS.map((tool) => ({
  argsDescription: tool.inputSchema.describe,
  description: tool.description,
  isConcurrencySafe: tool.concurrencySafe,
  isReadOnly: tool.readOnly,
  name: tool.name as AgentToolName,
  needsVerification: tool.requiresVerification,
})) satisfies AgentToolDefinition[];

export const AGENT_TOOL_NAMES = new Set<AgentToolName>(
  AGENT_TOOL_DEFINITIONS.map((tool) => tool.name),
);

export function getAgentToolDefinition(name: AgentToolName) {
  return AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

export function formatAgentToolListForPrompt(options: {
  includeTool?: (tool: AgentToolDefinition) => boolean;
} = {}) {
  return AGENT_TOOL_DEFINITIONS
    .filter((tool) => options.includeTool?.(tool) ?? true)
    .map(
    (tool) => {
      const description =
        tool.name === "run_command"
          ? `${tool.description} Command must exactly equal one of: ${AGENT_COMMANDS.join(", ")}. Do not add pipes, redirects, flags, package names, or shell operators.`
          : tool.description;

      return `- ${tool.name} args ${tool.argsDescription}: ${description}`;
    },
  ).join("\n");
}

export function isAgentToolName(value: string): value is AgentToolName {
  return AGENT_TOOL_NAMES.has(value as AgentToolName);
}

export function getAgentToolNamesForRuntime(): CoreToolName[] {
  return CORE_TOOL_DEFINITIONS.map((tool) => tool.name as CoreToolName);
}
