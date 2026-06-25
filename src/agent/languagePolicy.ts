export function formatUserLanguageInstruction(surface: string) {
  return [
    `${surface} must match the dominant natural language of the user's latest request, project brief, or revision feedback.`,
    "If the latest request is primarily Chinese, use Simplified Chinese.",
    "If the user explicitly asks for a different output language, follow that instruction.",
    "For mixed-language input, use the dominant natural language unless the user explicitly asks otherwise.",
    "Preserve code, identifiers, file paths, package names, commands, API names, log excerpts, and quoted source text in their original language.",
  ];
}

export function prefersSimplifiedChinese(userText: string) {
  for (const character of userText) {
    const codePoint = character.codePointAt(0);

    if (
      codePoint !== undefined &&
      ((codePoint >= 0x3400 && codePoint <= 0x9fff) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff))
    ) {
      return true;
    }
  }

  return false;
}

export function localizeUserFacingMessage(
  userText: string,
  message: { en: string; zhHans: string },
) {
  return prefersSimplifiedChinese(userText) ? message.zhHans : message.en;
}
