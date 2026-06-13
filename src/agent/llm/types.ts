export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DeepSeekClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};
