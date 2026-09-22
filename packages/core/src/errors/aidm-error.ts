export interface AidmErrorDetails {
  [key: string]: unknown;
}

/**
 * Base Error class for all AI Development Manager exceptions.
 * Encapsulates deterministic error code, user message, cause, and structured details.
 */
export class AidmError extends Error {
  readonly code: string;
  readonly details?: AidmErrorDetails;

  constructor(message: string, code = 'ERR_AIDM_GENERAL', details?: AidmErrorDetails) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;

    // Restore prototype chain for proper instanceof checks in transpiled code
    Object.setPrototypeOf(this, new.target.prototype);

    const errorConstructor = Error as unknown as {
      captureStackTrace?: (targetObject: object, constructorOpt?: Function) => void;
    };
    if (typeof errorConstructor.captureStackTrace === 'function') {
      errorConstructor.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      stack: this.stack,
    };
  }
}
