/** An expected error caused by the caller (invalid input, unknown id). Its message is safe to show as is. */
export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginError';
  }
}

/**
 * This process opened the store, and a newer Origin has since upgraded it. Writes stop. A
 * long-running `origin mcp` exits so its client starts the new process.
 */
export class StoreUpgradedError extends OriginError {
  constructor() {
    super('This store has been upgraded. Restart this process.');
    this.name = 'StoreUpgradedError';
  }
}

/** A record arrived under an id this store already holds with different content. */
export class ConflictError extends OriginError {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
