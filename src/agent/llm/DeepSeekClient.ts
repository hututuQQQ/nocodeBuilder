import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatMessage, DeepSeekClientConfig } from "./types";

type DeepSeekErrorCode =
  | "config"
  | "api_key"
  | "network"
  | "http"
  | "response_parse"
  | "json_parse";

type ChatCompletionResponse = {
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

type NativeChatCompletionResponse = {
  status: number;
  body: string;
};

type DeepSeekStreamEvent = {
  requestId: string;
  delta: string;
  done: boolean;
  timestamp: string;
};

type RawChatCompletionResponse = {
  ok: boolean;
  status: number;
  body: string;
};

type ChatJsonOptions = {
  onDelta?: (delta: string) => void;
};

export class DeepSeekClientError extends Error {
  readonly code: DeepSeekErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    code: DeepSeekErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "DeepSeekClientError";
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export class DeepSeekClient {
  private readonly config: DeepSeekClientConfig;

  constructor(config: DeepSeekClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.trim(),
      apiKey: config.apiKey.trim(),
      model: config.model.trim(),
    };
  }

  async chatJson<T>(
    messages: ChatMessage[],
    options: ChatJsonOptions = {},
  ): Promise<T> {
    return this.requestJson<T>(messages, undefined, options);
  }

  async testConnection(): Promise<boolean> {
    const result = await this.requestJson<{ ok?: unknown }>(
      [
        {
          role: "user",
          content: 'Return exactly this JSON object: {"ok":true}',
        },
      ],
      32,
    );

    return result.ok === true;
  }

  private async requestJson<T>(
    messages: ChatMessage[],
    maxTokens?: number,
    options: ChatJsonOptions = {},
  ): Promise<T> {
    const content = await this.createChatCompletion(
      this.withJsonInstruction(messages),
      maxTokens,
      options,
    );

    return parseAssistantJson<T>(content);
  }

  private async createChatCompletion(
    messages: ChatMessage[],
    maxTokens?: number,
    options: ChatJsonOptions = {},
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new DeepSeekClientError(
        "api_key",
        "请输入 DeepSeek API Key 后再测试连接。",
      );
    }

    if (!this.config.model) {
      throw new DeepSeekClientError("config", "请选择 DeepSeek 模型。");
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      response_format: { type: "json_object" },
      stream: Boolean(options.onDelta),
      temperature: 0,
      thinking: { type: "disabled" },
    };

    if (typeof maxTokens === "number") {
      body.max_tokens = maxTokens;
    }

    const response = await this.sendChatCompletion(body, options);
    const parsedResponse = parseApiResponse(response.body, response.ok);

    if (!response.ok) {
      throw createHttpError(response.status, parsedResponse, response.body);
    }

    const content = readAssistantContent(parsedResponse);

    if (!content) {
      throw new DeepSeekClientError(
        "response_parse",
        "DeepSeek 响应格式异常：未找到模型返回内容。",
      );
    }

    return content;
  }

  private async sendChatCompletion(
    body: Record<string, unknown>,
    options: ChatJsonOptions,
  ): Promise<RawChatCompletionResponse> {
    if (isTauriRuntime()) {
      if (options.onDelta) {
        return this.invokeNativeChatCompletionStream(body, options.onDelta);
      }

      return this.invokeNativeChatCompletion(body);
    }

    if (options.onDelta) {
      return this.fetchChatCompletionStream(body, options.onDelta);
    }

    return this.fetchChatCompletion(body);
  }

  private async invokeNativeChatCompletion(
    body: Record<string, unknown>,
  ): Promise<RawChatCompletionResponse> {
    try {
      const response = await invoke<NativeChatCompletionResponse>(
        "deepseek_chat_completion",
        {
          request: {
            apiKey: this.config.apiKey,
            body,
            url: this.getChatCompletionsUrl(),
          },
        },
      );

      return {
        body: response.body,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      };
    } catch (error) {
      throw createNetworkError(error);
    }
  }

  private async invokeNativeChatCompletionStream(
    body: Record<string, unknown>,
    onDelta: (delta: string) => void,
  ): Promise<RawChatCompletionResponse> {
    const requestId = `deepseek-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const unlisten = await listen<DeepSeekStreamEvent>(
      "deepseek-stream",
      (event) => {
        if (event.payload.requestId !== requestId || event.payload.done) {
          return;
        }

        if (event.payload.delta) {
          onDelta(event.payload.delta);
        }
      },
    );

    try {
      const response = await invoke<NativeChatCompletionResponse>(
        "deepseek_chat_completion_stream",
        {
          request: {
            apiKey: this.config.apiKey,
            body,
            requestId,
            url: this.getChatCompletionsUrl(),
          },
        },
      );

      return {
        body: response.body,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      };
    } catch (error) {
      throw createNetworkError(error);
    } finally {
      unlisten();
    }
  }

  private async fetchChatCompletion(
    body: Record<string, unknown>,
  ): Promise<RawChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(this.getChatCompletionsUrl(), {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });

      return {
        body: await response.text(),
        ok: response.ok,
        status: response.status,
      };
    } catch (error) {
      throw createNetworkError(error);
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  private async fetchChatCompletionStream(
    body: Record<string, unknown>,
    onDelta: (delta: string) => void,
  ): Promise<RawChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(this.getChatCompletionsUrl(), {
        body: JSON.stringify({
          ...body,
          stream: true,
        }),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        return {
          body: await response.text(),
          ok: response.ok,
          status: response.status,
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const boundary = findSseBoundary(buffer);

          if (!boundary) {
            break;
          }

          const eventText = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const delta = readSseDelta(eventText);

          if (delta) {
            assistantContent += delta;
            onDelta(delta);
          }
        }
      }

      if (buffer.trim()) {
        const delta = readSseDelta(buffer);

        if (delta) {
          assistantContent += delta;
          onDelta(delta);
        }
      }

      return {
        body: JSON.stringify({
          choices: [{ message: { content: assistantContent } }],
        }),
        ok: true,
        status: response.status,
      };
    } catch (error) {
      throw createNetworkError(error);
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  private getChatCompletionsUrl(): string {
    if (!this.config.baseUrl) {
      throw new DeepSeekClientError("config", "请输入 DeepSeek Base URL。");
    }

    let url: URL;

    try {
      url = new URL(this.config.baseUrl);
    } catch (error) {
      throw new DeepSeekClientError(
        "config",
        "DeepSeek Base URL 格式无效，请输入完整 URL。",
        { cause: error },
      );
    }

    const normalizedPath = url.pathname.replace(/\/+$/, "");

    if (!normalizedPath.endsWith("/chat/completions")) {
      url.pathname = `${normalizedPath}/chat/completions`;
    }

    url.search = "";
    url.hash = "";

    return url.toString();
  }

  private withJsonInstruction(messages: ChatMessage[]): ChatMessage[] {
    return [
      {
        role: "system",
        content:
          "You must respond with one valid JSON object only. Do not include markdown, code fences, or explanatory text.",
      },
      ...messages,
    ];
  }
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in globalThis;
}

function createNetworkError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return new DeepSeekClientError(
      "network",
      "网络错误：连接 DeepSeek API 超时，请检查网络、代理或 Base URL。",
      { cause: error },
    );
  }

  return new DeepSeekClientError(
    "network",
    "网络错误：无法连接 DeepSeek API，请检查网络、代理或 Base URL。",
    { cause: error },
  );
}

function parseApiResponse(
  responseText: string,
  isSuccessfulResponse: boolean,
): ChatCompletionResponse {
  if (!responseText.trim()) {
    return {};
  }

  try {
    return JSON.parse(responseText) as ChatCompletionResponse;
  } catch (error) {
    if (!isSuccessfulResponse) {
      return {};
    }

    throw new DeepSeekClientError(
      "response_parse",
      "DeepSeek 响应格式异常：API 返回的不是有效 JSON。",
      { cause: error },
    );
  }
}

function createHttpError(
  status: number,
  responseBody: ChatCompletionResponse,
  responseText: string,
) {
  const apiMessage = truncateMessage(
    responseBody.error?.message ?? responseBody.message ?? responseText.trim(),
  );
  const normalizedApiMessage = apiMessage.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    normalizedApiMessage.includes("authentication") ||
    normalizedApiMessage.includes("api key")
  ) {
    return new DeepSeekClientError(
      "api_key",
      "API Key 无效或没有访问权限，请检查 DeepSeek API Key。",
      { status },
    );
  }

  if (status === 429) {
    return new DeepSeekClientError(
      "http",
      `DeepSeek 请求受限或额度不足：${apiMessage || "请稍后重试。"}`,
      { status },
    );
  }

  if (status >= 500) {
    return new DeepSeekClientError(
      "http",
      `DeepSeek 服务暂时不可用（HTTP ${status}），请稍后重试。`,
      { status },
    );
  }

  return new DeepSeekClientError(
    "http",
    `DeepSeek API 请求失败（HTTP ${status}）：${
      apiMessage || "请检查 Base URL、模型和请求参数。"
    }`,
    { status },
  );
}

function readAssistantContent(response: ChatCompletionResponse) {
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

function findSseBoundary(buffer: string) {
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

function readSseDelta(eventText: string) {
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

function parseAssistantJson<T>(content: string): T {
  const jsonText = stripJsonCodeFence(content);

  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    throw new DeepSeekClientError(
      "json_parse",
      "JSON 解析失败：DeepSeek 没有返回有效 JSON，请重试或调整提示。",
      { cause: error },
    );
  }
}

function stripJsonCodeFence(content: string) {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function truncateMessage(message: string) {
  return message.length > 240 ? `${message.slice(0, 240)}...` : message;
}
