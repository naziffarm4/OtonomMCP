import { RiskLevel } from '../risk.js';
import type { GitPolicyDecision, GitOperationType } from '../git/git-types.js';

// ============================================================================
// 1. POLICY DECISION STATES
// ============================================================================

/**
 * Authoritative AIDM Policy Decision States.
 * - ALLOW: Operation is permitted under current policy constraints.
 * - REQUIRE_HUMAN: Operation requires explicit human authorization token.
 * - DENY: Operation is explicitly rejected by policy.
 * - BLOCKED: Operation is blocked due to safety/environmental violations.
 */
export const PolicyDecisionState = {
  ALLOW: 'ALLOW',
  REQUIRE_HUMAN: 'REQUIRE_HUMAN',
  DENY: 'DENY',
  BLOCKED: 'BLOCKED',
} as const;

export type PolicyDecisionState =
  (typeof PolicyDecisionState)[keyof typeof PolicyDecisionState];
export const POLICY_DECISION_STATES = Object.values(
  PolicyDecisionState
) as readonly PolicyDecisionState[];

export function isPolicyDecisionState(value: unknown): value is PolicyDecisionState {
  return (
    typeof value === 'string' &&
    (POLICY_DECISION_STATES as readonly string[]).includes(value)
  );
}

// ============================================================================
// 2. OPERATION ACTION TYPES
// ============================================================================

export const OperationActionType = {
  // Read / Inspection (SAFE)
  FILE_READ: 'FILE_READ',
  DIRECTORY_LIST: 'DIRECTORY_LIST',
  WORKSPACE_SEARCH: 'WORKSPACE_SEARCH',
  GIT_STATUS: 'GIT_STATUS',
  GIT_INSPECT: 'GIT_INSPECT',
  LINT_EXECUTION: 'LINT_EXECUTION',
  READ_ONLY_INSPECTION: 'READ_ONLY_INSPECTION',

  // Source / Normal modification (CAUTION)
  FILE_CREATE: 'FILE_CREATE',
  FILE_MODIFY: 'FILE_MODIFY',
  BUILD_EXECUTION: 'BUILD_EXECUTION',
  TEST_EXECUTION: 'TEST_EXECUTION',
  SOURCE_MUTATION: 'SOURCE_MUTATION',

  // Project configuration / Dependencies (DANGEROUS)
  DEPENDENCY_INSTALL: 'DEPENDENCY_INSTALL',
  PACKAGE_CONFIG_MUTATION: 'PACKAGE_CONFIG_MUTATION',
  DB_MIGRATION: 'DB_MIGRATION',
  ENVIRONMENT_CONFIG: 'ENVIRONMENT_CONFIG',
  GIT_RESET: 'GIT_RESET',
  GIT_ROLLBACK: 'GIT_ROLLBACK',

  // Irreversible / Destructive / System-wide (CRITICAL)
  BULK_DELETION: 'BULK_DELETION',
  WORKSPACE_ESCAPE: 'WORKSPACE_ESCAPE',
  GIT_FORCE_PUSH: 'GIT_FORCE_PUSH',
  GIT_BRANCH_DELETION: 'GIT_BRANCH_DELETION',
  CREDENTIAL_EXFILTRATION: 'CREDENTIAL_EXFILTRATION',
  SYSTEM_DESTRUCTIVE: 'SYSTEM_DESTRUCTIVE',
  SERVICE_CONTROL: 'SERVICE_CONTROL',
  DISK_PARTITION: 'DISK_PARTITION',
  COMMAND_EXECUTION: 'COMMAND_EXECUTION',
  CUSTOM: 'CUSTOM',
} as const;

export type OperationActionType =
  | (typeof OperationActionType)[keyof typeof OperationActionType]
  | string;

// ============================================================================
// 3. VIOLATION AND REQUEST CONTRACTS
// ============================================================================

export interface PolicyViolationItem {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Structured, provider-neutral representation of an operation request
 * evaluated by the AIDM Policy Engine.
 */
export interface PolicyOperationRequest {
  /** The high-level action category */
  readonly action_type?: OperationActionType;
  /** Raw command or execution descriptor */
  readonly command?: string;
  /** Command argument list */
  readonly command_args?: readonly string[];
  /** Target file, directory, or resource path(s) */
  readonly target_path?: string | readonly string[];
  /** Authoritative root of the project workspace */
  readonly project_root?: string;
  /** Working directory for the operation */
  readonly working_directory?: string;
  /** Whether the operation is strictly read-only */
  readonly is_read_only?: boolean;
  /** Whether the operation mutates application source files */
  readonly mutates_source?: boolean;
  /** Whether the operation mutates project configuration or manifest files */
  readonly mutates_config?: boolean;
  /** Whether the operation installs, updates, or modifies dependencies */
  readonly changes_dependencies?: boolean;
  /** Whether the operation involves or affects Git repository state */
  readonly affects_git?: boolean;
  /** Whether external network communication is required */
  readonly accesses_external_network?: boolean;
  /** Whether credentials, API keys, or secrets may be involved */
  readonly involves_secrets?: boolean;
  /** Explicit requested risk level (engine can elevate, never lower) */
  readonly requested_risk_level?: RiskLevel;
  /** Verified human approval token if authorized by human decision */
  readonly human_approval_token?: string | null;
  /** Additional structured metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;

  // CamelCase aliases for developer ergonomics
  readonly actionType?: OperationActionType;
  readonly commandArgs?: readonly string[];
  readonly targetPath?: string | readonly string[];
  readonly projectRoot?: string;
  readonly workingDirectory?: string;
  readonly isReadOnly?: boolean;
  readonly mutatesSource?: boolean;
  readonly mutatesConfig?: boolean;
  readonly changesDependencies?: boolean;
  readonly affectsGit?: boolean;
  readonly accessesExternalNetwork?: boolean;
  readonly involvesSecrets?: boolean;
  readonly requestedRiskLevel?: RiskLevel;
  readonly humanApprovalToken?: string | null;
}

// ============================================================================
// 4. POLICY DECISION AND CONFIGURATION CONTRACTS
// ============================================================================

/**
 * Structured, deterministic decision rendered by the AIDM Policy Engine.
 */
export interface PolicyDecision {
  /** Overall binary allowance determination */
  readonly allowed: boolean;
  /** Explicit policy state: ALLOW | REQUIRE_HUMAN | DENY | BLOCKED */
  readonly decision: PolicyDecisionState;
  /** Evaluated project risk level: SAFE | CAUTION | DANGEROUS | CRITICAL */
  readonly risk_level: RiskLevel;
  /** Deterministic machine-readable decision / rule code */
  readonly code: string;
  /** Primary human-readable justification */
  readonly reason: string;
  /** Full list of explanatory reasons */
  readonly reasons: readonly string[];
  /** Explicit indication of whether verified human authorization is required */
  readonly requires_human_authorization: boolean;
  /** Evaluated action type */
  readonly action_type?: string;
  /** Specific policy violations detected */
  readonly violations?: readonly PolicyViolationItem[];
  /** ISO 8601 evaluation timestamp */
  readonly evaluated_at: string;
  /** Associated Git policy decision if evaluated through Git policy boundary */
  readonly git_policy_decision?: GitPolicyDecision;
  /** Additional non-secret metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;

  // CamelCase aliases
  readonly riskLevel?: RiskLevel;
  readonly requiresHumanAuthorization?: boolean;
  readonly actionType?: string;
  readonly evaluatedAt?: string;
  readonly gitPolicyDecision?: GitPolicyDecision;
}

/**
 * Configuration options for the AIDM Policy Engine.
 */
export interface PolicyEngineConfig {
  /** Authoritative default workspace root directory */
  readonly project_root?: string;
  readonly projectRoot?: string;

  /** Whether dangerous operations are permitted under defined project constraints */
  readonly allow_dangerous_operations?: boolean;
  readonly allowDangerousOperations?: boolean;

  /** Whether dependency installations are permitted under project policy */
  readonly allow_dependency_installation?: boolean;
  readonly allowDependencyInstallation?: boolean;

  /** Whether dangerous operations require explicit human approval */
  readonly require_human_for_dangerous?: boolean;
  readonly requireHumanForDangerous?: boolean;

  /** Optional custom token validator */
  readonly validateHumanApprovalToken?: (
    token: string
  ) => boolean | { valid: boolean; reason?: string };
}

export const DEFAULT_POLICY_ENGINE_CONFIG: PolicyEngineConfig = Object.freeze({
  allow_dangerous_operations: true,
  allow_dependency_installation: true,
  require_human_for_dangerous: false,
});
