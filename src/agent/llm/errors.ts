import { DeepSeekErrorCode } from "./types";

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
