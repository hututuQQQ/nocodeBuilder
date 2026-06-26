import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getAiProviderDefinition,
  type AiProviderDefinition,
} from "../../services/aiProviders";
import { LlmClientError } from "./errors";
import { findSseBoundary, readSseDelta } from "./sse";
import {
  ChatCompletionResponse,
  ChatJsonOptions,
  ChatMessage,
  LlmClientConfig,
  LlmStreamEvent,
  NativeChatCompletionResponse,
  RawChatCompletionResponse,
} from "./types";

export { LlmClientError } from "./errors";

export class ChatCompletionClient {
  private readonly config: LlmClientConfig;
  private readonly provider: AiProviderDefinition;

  constructor(config: LlmClientConfig) {
    this.config = {
      provider: config.provider,
      baseUrl: config.baseUrl.trim(),
      apiKey: config.apiKey?.trim(),
      model: config.model.trim(),
    };
    this.provider = getAiProviderDefinition(this.config.provider);
  }

  async chatJson<T>(
    messages: ChatMessage[],
    options: ChatJsonOptions = {},
  ): Promise<T> {
    return this.requestJson<T>(messages, undefined, options);
  }

  async testConnection(): Promise<boolean> {
    this.validateConfig();

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: "Reply with the word ok.",
        },
      ],
      stream: false,
      temperature: 0,
      ...this.provider.requestBodyDefaults,
    };
    body.max_tokens = 16;

    const response = await this.sendChatCompletion(body, {});
    const parsedResponse = parseApiResponse(
      response.body,
      response.ok,
      this.provider.label,
    );

    if (!response.ok) {
      throw createHttpError(
        response.status,
        parsedResponse,
        response.body,
        this.provider.label,
      );
    }

    return isChatCompletionResponse(parsedResponse) || response.body.trim().length > 0;
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

    return parseAssistantJson<T>(content, this.provider.label);
  }

  private async createChatCompletion(
    messages: ChatMessage[],
    maxTokens?: number,
    options: ChatJsonOptions = {},
  ): Promise<string> {
    this.validateConfig();

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      response_format: { type: "json_object" },
      stream: Boolean(options.onDelta),
      temperature: 0,
      ...this.provider.requestBodyDefaults,
    };

    if (typeof maxTokens === "number") {
      body.max_tokens = maxTokens;
    }

    const response = await this.sendChatCompletion(body, options);
    const parsedResponse = parseApiResponse(
      response.body,
      response.ok,
      this.provider.label,
    );

    if (!response.ok) {
      throw createHttpError(
        response.status,
        parsedResponse,
        response.body,
        this.provider.label,
      );
    }

    const content = readAssistantContent(parsedResponse);

    if (!content) {
      throw new LlmClientError(
        "response_parse",
        `${this.provider.label} response did not include assistant content.`,
      );
    }

    return content;
  }

  private async sendChatCompletion(
    body: Record<string, unknown>,
    options: ChatJsonOptions,
  ): Promise<RawChatCompletionResponse> {
    throwIfAborted(options.signal);

    if (isTauriRuntime()) {
      if (options.onDelta) {
        return this.invokeNativeChatCompletionStream(body, options);
      }

      return this.invokeNativeChatCompletion(body, options);
    }

    if (options.onDelta) {
      return this.fetchChatCompletionStream(body, options);
    }

    return this.fetchChatCompletion(body, options);
  }

  private validateConfig() {
    if (!isTauriRuntime() && !this.config.apiKey) {
      throw new LlmClientError(
        "api_key",
        `Enter a ${this.provider.label} API key before testing the connection.`,
      );
    }

    if (!this.config.model) {
      throw new LlmClientError(
        "config",
        `Choose a ${this.provider.label} model.`,
      );
    }
  }

  private async invokeNativeChatCompletion(
    body: Record<string, unknown>,
    options: ChatJsonOptions,
  ): Promise<RawChatCompletionResponse> {
    try {
      const response = await raceAbort(
        invoke<NativeChatCompletionResponse>("llm_chat_completion", {
          request: {
            apiKey: this.config.apiKey,
            body,
            provider: this.config.provider,
            url: this.getChatCompletionsUrl(),
          },
        }),
        options.signal,
      );

      return {
        body: response.body,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      };
    } catch (error) {
      throw createNetworkError(error, this.provider.label);
    }
  }

  private async invokeNativeChatCompletionStream(
    body: Record<string, unknown>,
    options: ChatJsonOptions,
  ): Promise<RawChatCompletionResponse> {
    const requestId = `${this.config.provider}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const unlisten = await listen<LlmStreamEvent>("llm-stream", (event) => {
      if (event.payload.requestId !== requestId || event.payload.done) {
        return;
      }

      if (event.payload.delta && !options.signal?.aborted) {
        options.onDelta?.(event.payload.delta);
      }
    });

    try {
      const response = await raceAbort(
        invoke<NativeChatCompletionResponse>("llm_chat_completion_stream", {
          request: {
            apiKey: this.config.apiKey,
            body,
            provider: this.config.provider,
            requestId,
            url: this.getChatCompletionsUrl(),
          },
        }),
        options.signal,
      );

      return {
        body: response.body,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      };
    } catch (error) {
      throw createNetworkError(error, this.provider.label);
    } finally {
      unlisten();
    }
  }

  private async fetchChatCompletion(
    body: Record<string, unknown>,
    options: ChatJsonOptions,
  ): Promise<RawChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 30000);
    const unlistenAbort = linkAbortSignals(options.signal, controller);

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
      throw createNetworkError(error, this.provider.label);
    } finally {
      unlistenAbort();
      globalThis.clearTimeout(timeoutId);
    }
  }

  private async fetchChatCompletionStream(
    body: Record<string, unknown>,
    options: ChatJsonOptions,
  ): Promise<RawChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 120000);
    const unlistenAbort = linkAbortSignals(options.signal, controller);

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
            options.onDelta?.(delta);
          }
        }
      }

      if (buffer.trim()) {
        const delta = readSseDelta(buffer);

        if (delta) {
          assistantContent += delta;
          options.onDelta?.(delta);
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
      throw createNetworkError(error, this.provider.label);
    } finally {
      unlistenAbort();
      globalThis.clearTimeout(timeoutId);
    }
  }

  private getChatCompletionsUrl(): string {
    if (!this.config.baseUrl) {
      throw new LlmClientError(
        "config",
        `Enter a ${this.provider.label} Base URL.`,
      );
    }

    let url: URL;

    try {
      url = new URL(this.config.baseUrl);
    } catch (error) {
      throw new LlmClientError(
        "config",
        `${this.provider.label} Base URL is not a valid URL.`,
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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("The model request was cancelled.", "AbortError");
  }
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    function handleAbort() {
      reject(new DOMException("The model request was cancelled.", "AbortError"));
    }

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

function linkAbortSignals(source: AbortSignal | undefined, target: AbortController) {
  if (!source) {
    return () => undefined;
  }

  if (source.aborted) {
    target.abort();
    return () => undefined;
  }

  function abortTarget() {
    target.abort();
  }

  source.addEventListener("abort", abortTarget, { once: true });
  return () => source.removeEventListener("abort", abortTarget);
}

function createNetworkError(error: unknown, providerLabel: string) {
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmClientError(
      "network",
      `Network error: connecting to ${providerLabel} timed out. Check your network, proxy, or Base URL.`,
      { cause: error },
    );
  }

  return new LlmClientError(
    "network",
    `Network error: cannot connect to ${providerLabel}. Check your network, proxy, or Base URL.`,
    { cause: error },
  );
}

function parseApiResponse(
  responseText: string,
  isSuccessfulResponse: boolean,
  providerLabel: string,
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

    throw new LlmClientError(
      "response_parse",
      `${providerLabel} response was not valid JSON.`,
      { cause: error },
    );
  }
}

function createHttpError(
  status: number,
  responseBody: ChatCompletionResponse,
  responseText: string,
  providerLabel: string,
) {
  const apiMessage = truncateMessage(
    responseBody.error?.message ?? responseBody.message ?? responseText.trim(),
  );
  const apiErrorCode = String(responseBody.error?.code ?? "");
  const apiErrorType = String(responseBody.error?.type ?? "");
  const normalizedApiMessage = apiMessage.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    normalizedApiMessage.includes("authentication") ||
    normalizedApiMessage.includes("api key")
  ) {
    return new LlmClientError(
      "api_key",
      `API key is invalid or unauthorized. Check your ${providerLabel} API key.`,
      { status },
    );
  }

  if (isContextBudgetError(`${apiMessage} ${apiErrorCode} ${apiErrorType}`)) {
    return new LlmClientError(
      "context_budget",
      `${providerLabel} request exceeded the model context/token budget: ${
        apiMessage || "reduce prompt context and retry."
      }`,
      { status },
    );
  }

  if (status === 429) {
    return new LlmClientError(
      "http",
      `${providerLabel} request was rate limited or quota is insufficient: ${
        apiMessage || "try again later."
      }`,
      { status },
    );
  }

  if (status >= 500) {
    return new LlmClientError(
      "http",
      `${providerLabel} is temporarily unavailable (HTTP ${status}). Try again later.`,
      { status },
    );
  }

  return new LlmClientError(
    "http",
    `${providerLabel} API request failed (HTTP ${status}): ${
      apiMessage || "check Base URL, model, and request parameters."
    }`,
    { status },
  );
}

function readAssistantContent(response: ChatCompletionResponse) {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("")
      .trim();
  }

  return "";
}

function isChatCompletionResponse(response: ChatCompletionResponse) {
  return Array.isArray(response.choices) || Boolean(response.error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssistantJson<T>(content: string, providerLabel: string): T {
  const jsonText = stripJsonCodeFence(content);

  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    throw new LlmClientError(
      "json_parse",
      `JSON parse failed: ${providerLabel} did not return valid JSON. Try again or adjust the prompt.`,
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

function isContextBudgetError(message: string) {
  const normalized = message.toLowerCase();

  return [
    "context_length_exceeded",
    "context length",
    "context window",
    "maximum context",
    "max context",
    "too many tokens",
    "token limit",
    "tokens exceed",
    "input tokens",
    "input too long",
    "prompt too long",
    "request too large",
    "reduce the length",
    "exceeds the model",
    "exceeded the model",
  ].some((pattern) => normalized.includes(pattern));
}
