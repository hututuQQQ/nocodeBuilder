import type { FileTree } from "../../services/projects";
import type {
  ModificationContext,
  ProjectChatMessage,
  ProjectContextFile,
} from "./types";
import { formatProjectFileTree } from "./pathRules";

const MAX_RECENT_MESSAGES = 8;
const MAX_CONTEXT_FILE_CHARS = 80_000;

export function buildModificationContext({
  chatMessages,
  fileContents,
  fileTree,
}: {
  chatMessages: ProjectChatMessage[];
  fileContents: ProjectContextFile[];
  fileTree: FileTree;
}): ModificationContext {
  return {
    fileTree: formatProjectFileTree(fileTree),
    files: fileContents.map((file) => ({
      path: file.path,
      content: truncateContextFile(file.content),
    })),
    recentMessages: chatMessages
      .filter((message) => message.id !== "welcome")
      .slice(-MAX_RECENT_MESSAGES),
  };
}

function truncateContextFile(content: string) {
  if (content.length <= MAX_CONTEXT_FILE_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n\n/* Context truncated for prompt size. Return the complete file if you modify it. */`;
}
