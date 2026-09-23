/**
 * Standard deterministic exit codes for the AIDM CLI.
 * Conforms to Technical Discovery Section 20 & Phase 7 CLI specifications.
 */
export const CliExitCode = {
  /**
   * Command executed successfully and finished in a valid state.
   */
  SUCCESS: 0,

  /**
   * General unhandled operational error or unexpected runtime failure.
   */
  GENERAL_ERROR: 1,

  /**
   * Invalid CLI usage, unknown command, or invalid/missing arguments.
   */
  USAGE_ERROR: 2,

  /**
   * Requested operation was blocked by PolicyEngine or GitPolicyValidator.
   */
  POLICY_BLOCKED: 3,

  /**
   * Autonomous execution paused or stopped requiring human intervention / approval token.
   */
  HUMAN_BLOCKED: 4,

  /**
   * Autonomous development run completed, but one or more tasks failed/rejected and could not be recovered.
   */
  PROJECT_FAILED: 5,
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];
