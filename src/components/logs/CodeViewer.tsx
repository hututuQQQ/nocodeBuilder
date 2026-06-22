import Editor from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import "./monacoSetup";

type CodeViewerProps = {
  content: string;
  isLoading: boolean;
  path: string;
};

export function CodeViewer({ content, isLoading, path }: CodeViewerProps) {
  const language = getMonacoLanguage(path);
  const languageLabel = getLanguageLabel(language, path);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0b0b0d]">
      <Editor
        height="100%"
        language={language}
        loading={
          <div className="grid h-full place-items-center text-xs text-zinc-600">
            Loading editor
          </div>
        }
        options={{
          automaticLayout: true,
          contextmenu: true,
          cursorBlinking: "smooth",
          domReadOnly: true,
          folding: true,
          fontFamily:
            'JetBrains Mono, "Cascadia Code", "Fira Code", Consolas, monospace',
          fontLigatures: true,
          fontSize: 12,
          lineHeight: 19,
          lineNumbers: "on",
          minimap: {
            enabled: true,
            maxColumn: 90,
            renderCharacters: false,
            scale: 0.8,
          },
          padding: {
            bottom: 14,
            top: 14,
          },
          readOnly: true,
          renderLineHighlight: "line",
          renderValidationDecorations: "off",
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          wordWrap: "on",
        }}
        path={path}
        theme="nocode-dark"
        value={content}
      />

      {isLoading ? (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-xs text-zinc-500 shadow-lg shadow-black/30">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading
        </div>
      ) : languageLabel ? (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 shadow-lg shadow-black/30">
          {languageLabel}
        </div>
      ) : null}
    </div>
  );
}

export function getMonacoLanguage(path: string) {
  const normalizedPath = path.toLowerCase();
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;

  if (
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === ".npmrc" ||
    fileName === ".editorconfig" ||
    normalizedPath.endsWith(".ini") ||
    normalizedPath.endsWith(".toml")
  ) {
    return "ini";
  }

  if (normalizedPath.endsWith(".tsx") || normalizedPath.endsWith(".ts")) {
    return "typescript";
  }

  if (normalizedPath.endsWith(".jsx") || normalizedPath.endsWith(".js")) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".css")) {
    return "css";
  }

  if (normalizedPath.endsWith(".scss")) {
    return "scss";
  }

  if (normalizedPath.endsWith(".less")) {
    return "less";
  }

  if (normalizedPath.endsWith(".json") || normalizedPath.endsWith(".jsonc")) {
    return "json";
  }

  if (normalizedPath.endsWith(".md") || normalizedPath.endsWith(".mdx")) {
    return "markdown";
  }

  if (normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm")) {
    return "html";
  }

  if (normalizedPath.endsWith(".svg") || normalizedPath.endsWith(".xml")) {
    return "xml";
  }

  if (normalizedPath.endsWith(".yml") || normalizedPath.endsWith(".yaml")) {
    return "yaml";
  }

  if (
    normalizedPath.endsWith(".sh") ||
    normalizedPath.endsWith(".bash") ||
    normalizedPath.endsWith(".zsh") ||
    normalizedPath.endsWith(".ps1")
  ) {
    return "shell";
  }

  return "plaintext";
}

export function getLanguageLabel(language: string, path: string) {
  if (language === "plaintext") {
    return "";
  }

  if (path.toLowerCase().endsWith(".tsx")) {
    return "TSX";
  }

  if (path.toLowerCase().endsWith(".jsx")) {
    return "JSX";
  }

  return language;
}
