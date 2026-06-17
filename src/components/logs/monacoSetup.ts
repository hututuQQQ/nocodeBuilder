import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

type MonacoEnvironmentHost = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
};

(globalThis as MonacoEnvironmentHost).MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === "json") {
      return new jsonWorker();
    }

    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }

    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }

    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }

    return new editorWorker();
  },
};

monaco.editor.defineTheme("nocode-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "71717a", fontStyle: "italic" },
    { token: "keyword", foreground: "7dd3fc" },
    { token: "number", foreground: "fbbf24" },
    { token: "string", foreground: "86efac" },
    { token: "type", foreground: "c4b5fd" },
    { token: "identifier", foreground: "e5e7eb" },
    { token: "tag", foreground: "fda4af" },
    { token: "attribute.name", foreground: "facc15" },
    { token: "attribute.value", foreground: "86efac" },
    { token: "delimiter", foreground: "94a3b8" },
    { token: "variable", foreground: "e5e7eb" },
  ],
  colors: {
    "editor.background": "#0b0b0d",
    "editor.foreground": "#e5e7eb",
    "editor.lineHighlightBackground": "#18181b80",
    "editorLineNumber.activeForeground": "#99f6e4",
    "editorLineNumber.foreground": "#52525b",
    "editor.selectionBackground": "#14b8a640",
    "editor.inactiveSelectionBackground": "#3f3f464d",
    "editorIndentGuide.activeBackground1": "#52525b",
    "editorIndentGuide.background1": "#27272a",
    "scrollbarSlider.activeBackground": "#71717a80",
    "scrollbarSlider.background": "#3f3f4666",
    "scrollbarSlider.hoverBackground": "#52525b80",
  },
});

loader.config({ monaco });
