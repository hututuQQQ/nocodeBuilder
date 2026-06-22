import type { AgentToolCallStep } from "../agent/projectModifier";

export type AgentHookResult = {
  message?: string;
  ok: boolean;
};

export function runPreToolUseHooks(step: AgentToolCallStep): AgentHookResult {
  const secretContent = getWritableContent(step).find(containsSecretLikeValue);

  if (secretContent) {
    return {
      ok: false,
      message:
        "PreToolUse blocked the write because the content looks like it may contain a real secret or credential.",
    };
  }

  if (step.tool === "run_command" && isDangerousCommandText(step.args.command)) {
    return {
      ok: false,
      message: "PreToolUse blocked a command outside the agent command policy.",
    };
  }

  return { ok: true };
}

export function runPostToolUseHooks(
  step: AgentToolCallStep,
  result: { didChangeFiles?: boolean },
) {
  const notes: string[] = [];

  if (result.didChangeFiles) {
    notes.push(
      "PostToolUse: refreshed file state. Preview updates after the final verified change.",
    );
  }

  if (step.tool === "edit_file" || step.tool === "write_files") {
    notes.push("PostToolUse: file content passed secret scan.");
  }

  return notes;
}

function getWritableContent(step: AgentToolCallStep) {
  switch (step.tool) {
    case "edit_file":
      return [step.args.new_string];
    case "write_files":
      return step.args.files.map((file) => file.content);
    default:
      return [];
  }
}

function containsSecretLikeValue(content: string) {
  return [
    /sk-[A-Za-z0-9_-]{20,}/,
    /AIza[0-9A-Za-z_-]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /xox[abprs]-[0-9A-Za-z-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  ].some((pattern) => pattern.test(content));
}

function isDangerousCommandText(command: string) {
  return /(?:^|\s)(?:rm|del|erase|rmdir|mv|move|cp|copy|curl|wget|powershell|cmd|bash)(?:\s|$)/i.test(
    command,
  );
}
