export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DeepSeekClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type DeepSeekErrorCode =
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
      content?: string | null;
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

export type DeepSeekStreamEvent = {
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
