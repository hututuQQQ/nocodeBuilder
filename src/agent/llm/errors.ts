import type { LlmErrorCode } from "./types";

export class LlmClientError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LlmClientError";
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
  }
}
