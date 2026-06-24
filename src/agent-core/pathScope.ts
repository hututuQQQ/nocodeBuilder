export function normalizeProjectPath(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function isInvalidProjectPath(path: string) {
  const normalized = normalizeProjectPath(path);

  return (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.split("/").includes("..") ||
    /^[A-Za-z]:\//.test(normalized)
  );
}

export function matchesProjectPathPattern(path: string, pattern: string) {
  const normalizedPath = normalizeProjectPath(path);
  const normalizedPattern = normalizeProjectPath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.includes("*")) {
    return globToRegExp(normalizedPattern).test(normalizedPath);
  }

  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`)
  );
}

export function isPathAllowed(path: string, allowedPatterns: string[]) {
  return (
    !isInvalidProjectPath(path) &&
    allowedPatterns.some((pattern) => matchesProjectPathPattern(path, pattern))
  );
}

export function isPathForbidden(path: string, forbiddenPatterns: string[]) {
  const normalized = normalizeProjectPath(path);

  return (
    isInvalidProjectPath(path) ||
    normalized === ".aibuilder" ||
    normalized.startsWith(".aibuilder/") ||
    normalized.startsWith(".env") ||
    normalized.includes("/.env") ||
    forbiddenPatterns.some((pattern) =>
      matchesProjectPathPattern(normalized, pattern),
    )
  );
}

function globToRegExp(pattern: string) {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
