/** An expected error caused by the caller (invalid input, unknown id). Its message is safe to show as is. */
export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginError';
  }
}

/** A record arrived under an id this store already holds with different content. */
export class ConflictError extends OriginError {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
