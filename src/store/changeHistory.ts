export type FileChangeSummary = {
  action: "created" | "deleted" | "modified";
  additions: number;
  afterContent: string | null;
  beforeContent: string | null;
  deletions: number;
  path: string;
  revertedAt?: string;
  sampleAddedLines: string[];
  sampleRemovedLines: string[];
  unifiedDiff: string;
};

export type ChangeRecord = {
  id: string;
  createdAt: string;
  files: FileChangeSummary[];
  kind: "agent" | "revert";
  projectId: string;
  revertedAt?: string;
  revertedByChangeId?: string;
  summary: string;
};

export const MAX_CHANGE_HISTORY_RECORDS = 50;

export type PendingReviewFile = FileChangeSummary & {
  lastChangedAt: string;
  recordIds: string[];
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
    kind: "agent",
    projectId,
    summary,
  };
}

export function createFileChangeSummary(
  path: string,
  beforeContent: string | null,
  afterContent: string | null,
): FileChangeSummary {
  return summarizeFileChange(path, beforeContent, afterContent);
}

export function getPendingReviewFiles(records: ChangeRecord[]): PendingReviewFile[] {
  const filesByPath = new Map<
    string,
    {
      afterContent: string | null;
      beforeContent: string | null;
      lastChangedAt: string;
      path: string;
      recordIds: string[];
      summary: string;
    }
  >();
  const orderedRecords = records
    .filter((record) => record.kind !== "revert" && !record.revertedAt)
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const record of orderedRecords) {
    for (const file of record.files) {
      if (file.revertedAt) {
        continue;
      }

      const current = filesByPath.get(file.path);

      filesByPath.set(file.path, {
        afterContent: file.afterContent,
        beforeContent: current?.beforeContent ?? file.beforeContent,
        lastChangedAt: record.createdAt,
        path: file.path,
        recordIds: [...(current?.recordIds ?? []), record.id],
        summary: record.summary,
      });
    }
  }

  return Array.from(filesByPath.values())
    .map((file) => ({
      ...createFileChangeSummary(
        file.path,
        file.beforeContent,
        file.afterContent,
      ),
      lastChangedAt: file.lastChangedAt,
      recordIds: file.recordIds,
      summary: file.summary,
    }))
    .filter((file) => file.beforeContent !== file.afterContent)
    .sort(
      (left, right) =>
        right.lastChangedAt.localeCompare(left.lastChangedAt) ||
        left.path.localeCompare(right.path),
    );
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

    const diffPreview = file.unifiedDiff.split("\n").slice(0, 12);

    if (diffPreview.length > 0) {
      lines.push("  Diff preview:");

      for (const diffLine of diffPreview) {
        lines.push(`  ${diffLine}`);
      }
    }
  }

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
    revertedAt: undefined,
    sampleAddedLines: sampleChangedLines(afterLines, beforeLines),
    sampleRemovedLines: beforeContent === null ? [] : sampleChangedLines(beforeLines, afterLines),
    unifiedDiff: createUnifiedDiff(path, beforeContent, afterContent),
  };
}

function createUnifiedDiff(
  path: string,
  beforeContent: string | null,
  afterContent: string | null,
) {
  const beforeLines = splitLines(beforeContent ?? "");
  const afterLines = splitLines(afterContent ?? "");
  let prefixLength = 0;

  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < beforeLines.length - prefixLength &&
    suffixLength < afterLines.length - prefixLength &&
    beforeLines[beforeLines.length - 1 - suffixLength] ===
      afterLines[afterLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const removedLines = beforeLines.slice(
    prefixLength,
    beforeLines.length - suffixLength,
  );
  const addedLines = afterLines.slice(prefixLength, afterLines.length - suffixLength);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefixLength + 1},${removedLines.length} +${prefixLength + 1},${addedLines.length} @@`,
  ];

  for (const line of removedLines.slice(0, 60)) {
    lines.push(`-${line}`);
  }

  for (const line of addedLines.slice(0, 60)) {
    lines.push(`+${line}`);
  }

  if (removedLines.length + addedLines.length > 120) {
    lines.push("[Diff truncated.]");
  }

  return lines.join("\n");
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
