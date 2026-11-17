export class ApiError extends Error {
  constructor(public readonly status: number, public readonly payload: unknown, public readonly retryAfterSeconds?: number) {
    super(`API request failed: ${status}`);
  }
}
