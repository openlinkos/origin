/** An expected error caused by the caller (invalid input, unknown id). Its message is safe to show as is. */
export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginError';
  }
}
