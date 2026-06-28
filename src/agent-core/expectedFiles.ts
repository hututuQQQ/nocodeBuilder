import {
  isInvalidProjectPath,
  normalizeProjectPath,
} from "./pathScope";

export function normalizeExpectedFiles(paths: readonly string[] | undefined): string[] {
  return uniqueStrings(
    (paths ?? [])
      .map(normalizeProjectPath)
      .filter((path) => path && !isInvalidProjectPath(path))
      .filter((path) => !isPlaceholderExpectedFile(path)),
  );
}

export function isPlaceholderExpectedFile(path: string): boolean {
  return path.split("/").pop() === ".gitkeep";
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
