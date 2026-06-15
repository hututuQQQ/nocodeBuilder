export type FileChangeSummary = {
  action: "created" | "deleted" | "modified";
  additions: number;
  afterContent: string | null;
  beforeContent: string | null;
  deletions: number;
  path: string;
  sampleAddedLines: string[];
  sampleRemovedLines: string[];
};

export type ChangeRecord = {
  id: string;
  createdAt: string;
  files: FileChangeSummary[];
  projectId: string;
  summary: string;
};

export function createChangeRecord(
  projectId: string,
  summary: string,
  files: Array<{ path: string; content: string | null }>,
  beforeContents: Map<string, string | null>,
): ChangeRecord {
  return {
    id: `change-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    files: files.map((file) =>
      summarizeFileChange(
        file.path,
        beforeContents.get(file.path) ?? null,
        file.content,
      ),
    ),
    projectId,
    summary,
  };
}

export function formatChangeRecordMessage(summary: string, record: ChangeRecord) {
  const lines = [summary, "", "Changed files:"];

  for (const file of record.files) {
    lines.push(
      `- ${file.path} (${file.action}, +${file.additions}/-${file.deletions})`,
    );

    for (const addedLine of file.sampleAddedLines.slice(0, 3)) {
      lines.push(`  + ${addedLine}`);
    }

    for (const removedLine of file.sampleRemovedLines.slice(0, 2)) {
      lines.push(`  - ${removedLine}`);
    }
  }

  lines.push("", "Rollback is available from the chat toolbar.");
  return lines.join("\n");
}

function summarizeFileChange(
  path: string,
  beforeContent: string | null,
  afterContent: string | null,
): FileChangeSummary {
  const beforeLines = splitLines(beforeContent ?? "");
  const afterLines = splitLines(afterContent ?? "");
  const commonCount = countCommonLines(beforeLines, afterLines);
  const additions = Math.max(0, afterLines.length - commonCount);
  const deletions =
    beforeContent === null ? 0 : Math.max(0, beforeLines.length - commonCount);

  return {
    action:
      afterContent === null
        ? "deleted"
        : beforeContent === null
          ? "created"
          : "modified",
    additions,
    afterContent,
    beforeContent,
    deletions,
    path,
    sampleAddedLines: sampleChangedLines(afterLines, beforeLines),
    sampleRemovedLines: beforeContent === null ? [] : sampleChangedLines(beforeLines, afterLines),
  };
}

function splitLines(content: string) {
  return content.split(/\r?\n/);
}

function countCommonLines(left: string[], right: string[]) {
  const counts = new Map<string, number>();
  let common = 0;

  for (const line of left) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  for (const line of right) {
    const count = counts.get(line) ?? 0;

    if (count > 0) {
      common += 1;
      counts.set(line, count - 1);
    }
  }

  return common;
}

function sampleChangedLines(source: string[], comparison: string[]) {
  const comparisonCounts = new Map<string, number>();
  const samples: string[] = [];

  for (const line of comparison) {
    comparisonCounts.set(line, (comparisonCounts.get(line) ?? 0) + 1);
  }

  for (const line of source) {
    const count = comparisonCounts.get(line) ?? 0;

    if (count > 0) {
      comparisonCounts.set(line, count - 1);
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    samples.push(trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed);

    if (samples.length >= 5) {
      break;
    }
  }

  return samples;
}
