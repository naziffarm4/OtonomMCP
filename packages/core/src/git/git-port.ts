import type {
  GitState,
  GitOperationIntent,
  GitPolicyDecision,
  GitExecutionResult,
} from './git-types.js';

export interface RemoteVerificationResult {
  readonly verified: boolean;
  readonly remoteHeadSha: string | null;
  readonly error?: string;
}

/**
 * Provider-neutral Git execution abstraction port.
 *
 * Boundary Pipeline:
 * GitPort (inspect) -> GitPolicyValidator (decide) -> GitPort (execute authorized) -> GitExecutionResult
 *
 * Implementations MUST strictly decouple policy validation from execution.
 * Mutating commands require prior policy authorization.
 * Force push execution is strictly forbidden and must be rejected unconditionally.
 */
export interface GitPort {
  /**
   * Inspects current workspace Git status in a read-only, non-mutating manner.
   */
  inspectState(workingDirectory: string): Promise<GitState>;

  /**
   * Verifies remote branch and head commit in a read-only manner without altering local or remote state.
   */
  verifyRemote(
    workingDirectory: string,
    remote: string,
    branch: string,
    expectedCommitSha?: string
  ): Promise<RemoteVerificationResult>;

  /**
   * Executes an operation that has ALREADY been validated and authorized by GitPolicyValidator.
   * If authorization is not provided or authorization.allowed is false, execution is rejected.
   * Force push requests MUST be rejected unconditionally without invoking any Git command.
   */
  executeAuthorizedOperation(
    intent: GitOperationIntent,
    authorization: GitPolicyDecision,
    workingDirectory: string
  ): Promise<GitExecutionResult>;

  /**
   * Checks whether a commit SHA exists in the repository object database in a read-only manner.
   */
  checkCommitExists?(workingDirectory: string, commitSha: string): Promise<boolean>;
}
