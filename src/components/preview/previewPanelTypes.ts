export type Notice = {
  tone: "error" | "success";
  message: string;
};

export type PreviewTab = "local" | "deployment";

export function getExplicitVercelProjectName(
  value: string | null | undefined,
  localProjectId: string | undefined,
) {
  const projectName = value?.trim() ?? "";

  if (!projectName || projectName === localProjectId) {
    return undefined;
  }

  return projectName;
}
