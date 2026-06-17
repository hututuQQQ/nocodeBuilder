import type { AiProviderId } from "../../services/aiProviders";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmClientConfig = {
  provider: AiProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type LlmErrorCode =
  | "config"
  | "api_key"
  | "network"
  | "http"
  | "response_parse"
  | "json_parse";

export type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ text?: string | null }> | null;
    };
  }>;
  error?: {
    code?: string | number | null;
    message?: string | null;
    type?: string | null;
  };
  message?: string;
};

export type NativeChatCompletionResponse = {
  status: number;
  body: string;
};

export type LlmStreamEvent = {
  requestId: string;
  delta: string;
  done: boolean;
  timestamp: string;
};

export type RawChatCompletionResponse = {
  ok: boolean;
  status: number;
  body: string;
};

export type ChatJsonOptions = {
  onDelta?: (delta: string) => void;
};
