import Editor from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import "./monacoSetup";

type CodeViewerProps = {
  content: string;
  isLoading: boolean;
  path: string;
};

export function CodeViewer({ content, isLoading, path }: CodeViewerProps) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0b0b0d]">
      <Editor
        height="100%"
        language={getMonacoLanguage(path)}
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
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          wordWrap: "on",
        }}
        path={path}
        theme="vs-dark"
        value={content}
      />

      {isLoading ? (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-xs text-zinc-500 shadow-lg shadow-black/30">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading
        </div>
      ) : null}
    </div>
  );
}

function getMonacoLanguage(path: string) {
  const normalizedPath = path.toLowerCase();

  if (normalizedPath.endsWith(".tsx") || normalizedPath.endsWith(".ts")) {
    return "typescript";
  }

  if (normalizedPath.endsWith(".jsx") || normalizedPath.endsWith(".js")) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".css")) {
    return "css";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
  }

  if (normalizedPath.endsWith(".md")) {
    return "markdown";
  }

  if (normalizedPath.endsWith(".html")) {
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
    normalizedPath.endsWith(".env")
  ) {
    return "shell";
  }

  return "plaintext";
}
