export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
  static badRequest(message: string, details?: unknown) { return new ApiError(400, 'BAD_REQUEST', message, details); }
  static unauthorized(message = 'Unauthorized') { return new ApiError(401, 'UNAUTHORIZED', message); }
  static notFound(message = 'Not found') { return new ApiError(404, 'NOT_FOUND', message); }
  static conflict(message: string, details?: unknown) { return new ApiError(409, 'CONFLICT', message, details); }
  static unprocessable(message: string, details?: unknown) { return new ApiError(422, 'UNPROCESSABLE', message, details); }
}

/** Domain-level rejection of an order command; carries a machine-readable status for the language layer. */
export class CommandRejected extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
