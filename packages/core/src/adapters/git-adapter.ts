/**
 * GitAdapter: Checkpoint, commit, tag, and rollback management abstraction.
 *
 * Implements the project-independent adapter contract specified in
 * Technical Discovery Section 22:
 * "GitAdapter: Checkpoint, commit, tag ve diff işlemlerini yönetir."
 */

import { type GitCheckpointManager, type KnownGoodCheckpoint, type CreateCheckpointOptions } from '../git/git-checkpoint-manager.js';
import { type GitRollbackManager } from '../git/git-rollback-manager.js';
import { type GitState, type GitRollbackResult, type RollbackOptions, type GitExecutionResult, type GitOperationIntent, type GitPolicyDecision } from '../git/git-types.js';
import { type GitPort } from '../git/git-port.js';

export interface GitAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * Inspects current repository state.
   */
  inspectState(projectRoot: string): Promise<GitState>;

  /**
   * Creates a verified known-good checkpoint.
   */
  createCheckpoint(options: CreateCheckpointOptions): Promise<KnownGoodCheckpoint>;

  /**
   * Performs an atomic rollback to a known checkpoint.
   */
  rollback(checkpointId: string, options?: RollbackOptions): Promise<GitRollbackResult>;

  /**
   * Executes an authorized Git operation.
   */
  executeAuthorizedOperation(
    intent: GitOperationIntent,
    authorization: GitPolicyDecision,
    workingDirectory: string
  ): Promise<GitExecutionResult>;
}

/**
 * Default Git adapter wrapping GitCheckpointManager and GitPort.
 */
export class DefaultGitAdapter implements GitAdapter {
  readonly id = 'adapter:git:default';
  readonly name = 'Default Git Adapter';

  private readonly checkpointManager: GitCheckpointManager;
  private readonly rollbackManager: GitRollbackManager;
  private readonly gitPort: GitPort;

  constructor(checkpointManager: GitCheckpointManager, gitPort: GitPort) {
    this.checkpointManager = checkpointManager;
    this.rollbackManager = checkpointManager.getRollbackManager();
    this.gitPort = gitPort;
  }

  async inspectState(projectRoot: string): Promise<GitState> {
    return this.gitPort.inspectState(projectRoot);
  }

  async createCheckpoint(options: CreateCheckpointOptions): Promise<KnownGoodCheckpoint> {
    return this.checkpointManager.createCheckpoint(options);
  }

  async rollback(checkpointId: string, options?: RollbackOptions): Promise<GitRollbackResult> {
    return this.rollbackManager.rollbackToCheckpoint(checkpointId, options);
  }

  async executeAuthorizedOperation(
    intent: GitOperationIntent,
    authorization: GitPolicyDecision,
    workingDirectory: string
  ): Promise<GitExecutionResult> {
    return this.gitPort.executeAuthorizedOperation(intent, authorization, workingDirectory);
  }
}
