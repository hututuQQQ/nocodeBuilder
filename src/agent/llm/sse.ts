export function findSseBoundary(buffer: string) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (crlfIndex >= 0) {
    return { index: crlfIndex, length: 4 };
  }

  const lfIndex = buffer.indexOf("\n\n");

  if (lfIndex >= 0) {
    return { index: lfIndex, length: 2 };
  }

  return null;
}

export function readSseDelta(eventText: string) {
  let content = "";

  for (const line of eventText.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice("data:".length).trim();

    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string | null;
          };
        }>;
      };

      content += parsed.choices?.[0]?.delta?.content ?? "";
    } catch {
      continue;
    }
  }

  return content;
}
