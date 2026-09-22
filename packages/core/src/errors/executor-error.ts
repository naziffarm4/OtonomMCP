import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export type ExecutorErrorCode =
  | 'ERR_INVALID_EXECUTOR_INSTRUCTION'
  | 'ERR_UNSUPPORTED_OPERATION'
  | 'ERR_EXECUTOR_UNAVAILABLE'
  | 'ERR_EXECUTOR_EXECUTION_FAILURE'
  | 'ERR_ADAPTER_TRANSLATION_FAILURE';

export interface InvalidExecutorInstructionDetails extends AidmErrorDetails {
  taskId?: string;
  instructionId?: string;
  field?: string;
  reason?: string;
  validationErrors?: string[];
}

export class InvalidExecutorInstructionError extends AidmError {
  readonly taskId?: string;
  readonly instructionId?: string;
  readonly field?: string;
  readonly reason?: string;
  readonly validationErrors?: string[];

  constructor(
    message: string,
    details?: InvalidExecutorInstructionDetails,
    code: ExecutorErrorCode = 'ERR_INVALID_EXECUTOR_INSTRUCTION'
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'InvalidExecutorInstructionError';
    this.taskId = details?.taskId;
    this.instructionId = details?.instructionId;
    this.field = details?.field;
    this.reason = details?.reason;
    this.validationErrors = details?.validationErrors;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface UnsupportedOperationDetails extends AidmErrorDetails {
  operation?: string;
  supportedOperations?: readonly string[];
  executorId?: string;
  reason?: string;
}

export class UnsupportedOperationError extends AidmError {
  readonly operation?: string;
  readonly supportedOperations?: readonly string[];
  readonly executorId?: string;

  constructor(
    message: string,
    details?: UnsupportedOperationDetails,
    code: ExecutorErrorCode = 'ERR_UNSUPPORTED_OPERATION'
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'UnsupportedOperationError';
    this.operation = details?.operation;
    this.supportedOperations = details?.supportedOperations;
    this.executorId = details?.executorId;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ExecutorUnavailableDetails extends AidmErrorDetails {
  executorId?: string;
  provider?: string;
  binaryPath?: string;
  reason?: string;
}

export class ExecutorUnavailableError extends AidmError {
  readonly executorId?: string;
  readonly provider?: string;
  readonly binaryPath?: string;
  readonly reason?: string;

  constructor(
    message: string,
    details?: ExecutorUnavailableDetails,
    code: ExecutorErrorCode = 'ERR_EXECUTOR_UNAVAILABLE'
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'ExecutorUnavailableError';
    this.executorId = details?.executorId;
    this.provider = details?.provider;
    this.binaryPath = details?.binaryPath;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ExecutorExecutionDetails extends AidmErrorDetails {
  taskId?: string;
  instructionId?: string;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string | null;
  reason?: string;
}

export class ExecutorExecutionError extends AidmError {
  readonly taskId?: string;
  readonly instructionId?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stderr?: string | null;

  constructor(
    message: string,
    details?: ExecutorExecutionDetails,
    code: ExecutorErrorCode = 'ERR_EXECUTOR_EXECUTION_FAILURE'
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'ExecutorExecutionError';
    this.taskId = details?.taskId;
    this.instructionId = details?.instructionId;
    this.exitCode = details?.exitCode;
    this.signal = details?.signal;
    this.stderr = details?.stderr;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AdapterTranslationDetails extends AidmErrorDetails {
  adapterName?: string;
  targetProvider?: string;
  instructionId?: string;
  field?: string;
  reason?: string;
}

export class AdapterTranslationError extends AidmError {
  readonly adapterName?: string;
  readonly targetProvider?: string;
  readonly instructionId?: string;
  readonly field?: string;
  readonly reason?: string;

  constructor(
    message: string,
    details?: AdapterTranslationDetails,
    code: ExecutorErrorCode = 'ERR_ADAPTER_TRANSLATION_FAILURE'
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'AdapterTranslationError';
    this.adapterName = details?.adapterName;
    this.targetProvider = details?.targetProvider;
    this.instructionId = details?.instructionId;
    this.field = details?.field;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
