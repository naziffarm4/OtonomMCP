import * as path from 'node:path';
import { RiskLevel, isRiskLevel } from '../risk.js';
import {
  type PolicyOperationRequest,
  type PolicyDecision,
  type PolicyEngineConfig,
  type PolicyViolationItem,
  PolicyDecisionState,
  OperationActionType,
  DEFAULT_POLICY_ENGINE_CONFIG,
} from './policy-types.js';
import {
  GitPolicyValidator,
  DEFAULT_GIT_POLICY_CONFIG,
} from '../git/git-policy-validator.js';
import {
  type GitOperationIntent,
  type GitPolicyDecision,
  GitOperationType,
  createGitState,
} from '../git/git-types.js';

// ============================================================================
// 1. DETERMINISTIC PATTERN MATCHER HELPERS
// ============================================================================

/**
 * Checks whether targetPath escapes projectRoot using path resolution and relative path calculation.
 */
function isPathEscapingRoot(targetPath: string, rootDir: string): boolean {
  if (!targetPath || !rootDir) return false;
  const normRoot = path.resolve(rootDir);
  const normTarget = path.resolve(normRoot, targetPath);
  const rel = path.relative(normRoot, normTarget);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * Detects bulk deletion commands (e.g. rm -rf, rmdir /s, git clean -fdx).
 */
function isBulkDeletionCommand(cmd: string): boolean {
  const normalized = cmd.trim();
  if (/\brm\s+(-[a-zA-Z0-9]*[rf][a-zA-Z0-9]*\s*)+/i.test(normalized)) return true;
  if (/\brmdir\s+[\/\\][sS]\b/i.test(normalized)) return true;
  if (/\bgit\s+clean\b/i.test(normalized) && /-[a-zA-Z0-9]*f/i.test(normalized)) return true;
  return false;
}

/**
 * Detects OS-level destructive operations (formatting, disk partitioning, service shutdown).
 */
function isOsDestructiveCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  if (/\b(format\s+[a-z]:|mkfs(\.[a-z0-9]+)?\s+|fdisk\s+|diskpart\b|dd\s+if=\/dev\/)/i.test(lower)) {
    return true;
  }
  if (/\b(systemctl\s+stop|service\s+\w+\s+stop|net\s+stop\s+|sc\s+stop\s+|kill\s+-9\s+1\b)/i.test(lower)) {
    return true;
  }
  if (/\b(shutdown(\s+.*)?|reboot\b|init\s+0\b|poweroff\b)/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Detects Git force push patterns.
 */
function isGitForcePushCommand(cmd: string): boolean {
  return /\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease\b)/i.test(cmd);
}

/**
 * Detects Git remote branch deletion patterns.
 */
function isGitRemoteDeletionCommand(cmd: string): boolean {
  return (
    /\bgit\s+push\b.*(--delete\b|-d\b)/i.test(cmd) ||
    /\bgit\s+push\b.*:\w+/i.test(cmd)
  );
}

/**
 * Detects credential/secret exfiltration patterns over network.
 */
function isCredentialExfiltration(request: PolicyOperationRequest, cmd: string): boolean {
  if (
    request.action_type === OperationActionType.CREDENTIAL_EXFILTRATION ||
    request.actionType === OperationActionType.CREDENTIAL_EXFILTRATION
  ) {
    return true;
  }
  if (
    (request.involves_secrets || request.involvesSecrets) &&
    (request.accesses_external_network || request.accessesExternalNetwork)
  ) {
    return true;
  }
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  const hasNetTool = /\b(curl|wget|nc|netcat|ncat|scp|rsync|telnet)\b/i.test(lower);
  const hasSensitiveTarget =
    /(?:^|[\s@/\\=])(\.env|\.env\.[a-z]+|id_rsa|id_ed25519|id_dsa|credentials|\.aws\/credentials|\.npmrc|\w+\.pem|\w+\.key)\b/i.test(
      lower
    );
  if (hasNetTool && hasSensitiveTarget) return true;
  if (/\bcat\s+.*(\.env|id_rsa|credentials).*\|\s*(curl|wget|nc|base64)/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Detects dependency installation commands.
 */
function isDependencyInstallationCommand(cmd: string): boolean {
  return /\b(npm|pnpm|yarn|pip|pip3|cargo|composer|go)\s+(install|add|i|update|upgrade|remove|uninstall)\b/i.test(
    cmd
  );
}

/**
 * Checks whether target path is a recognized package manifest or project configuration file.
 */
function isPackageOrConfigPath(targetPath: string): boolean {
  const base = path.basename(targetPath).toLowerCase();
  const configFiles = [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'cargo.toml',
    'cargo.lock',
    'requirements.txt',
    'gemfile',
    'go.mod',
    'go.sum',
    'tsconfig.json',
    'docker-compose.yml',
    'docker-compose.yaml',
  ];
  if (configFiles.includes(base)) return true;
  if (base.startsWith('.eslintrc') || base.startsWith('.prettierrc')) return true;
  return false;
}

/**
 * Sanitizes sensitive substrings from error/reason messages to prevent token/secret leakage.
 */
function sanitizeMessage(msg: string): string {
  if (!msg) return msg;
  return msg
    .replace(/(?:bearer\s+|token\s+|key\s+|password\s*[:=]\s*)([a-zA-Z0-9_\-\.]{8,})/gi, '[REDACTED]')
    .replace(/(ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9\-_]{20,}|auth-token-[a-zA-Z0-9\-_]+)/gi, '[REDACTED_TOKEN]');
}

// ============================================================================
// 2. AIDM POLICY ENGINE IMPLEMENTATION
// ============================================================================

/**
 * AIDM Policy Engine and Risk Policy Boundary.
 *
 * Responsibilities:
 * - Operates as an independent security boundary in Phase 6.
 * - Does NOT treat Antigravity CLI flags (e.g. --dangerously-skip-permissions) as security authorization.
 * - Enforces the 4-tier risk classification: SAFE, CAUTION, DANGEROUS, CRITICAL.
 * - SAFE: Automatically allowed (read-only, inspection, search, lint).
 * - CAUTION: Automatically allowed within project workspace (normal source code modifications, builds, tests).
 * - DANGEROUS: Allowed under defined project/policy constraints (dependency installation, config changes, migrations).
 * - CRITICAL: Never silently allowed; strictly requires verified human authorization token.
 * - Prohibits force push, destructive remote branch deletion, OS formatting/partitioning, and root bulk deletions.
 * - Enforces project root containment and path traversal protection.
 * - Integrates with and delegates Git operations to the existing GitPolicyValidator.
 * - Guarantees zero secret/token leakage in results and errors.
 * - Fails closed on malformed, null, or empty requests.
 */
export class PolicyEngine {
  readonly config: PolicyEngineConfig;
  readonly gitPolicyValidator: GitPolicyValidator;

  constructor(
    config?: Partial<PolicyEngineConfig>,
    gitPolicyValidator?: GitPolicyValidator
  ) {
    this.config = Object.freeze({
      ...DEFAULT_POLICY_ENGINE_CONFIG,
      ...config,
    });
    this.gitPolicyValidator = gitPolicyValidator ?? new GitPolicyValidator();
  }

  /**
   * Deterministically classifies an operation request into an authoritative RiskLevel.
   */
  classifyOperation(request: PolicyOperationRequest): RiskLevel {
    if (!request || typeof request !== 'object') {
      return RiskLevel.CRITICAL;
    }

    const action = request.action_type ?? request.actionType;
    const cmd = (request.command ?? '').trim();
    const projectRoot = request.project_root ?? request.projectRoot ?? this.config.project_root ?? this.config.projectRoot ?? process.cwd();
    const rawTarget = request.target_path ?? request.targetPath;
    const targetPaths: string[] = [];
    if (typeof rawTarget === 'string' && rawTarget.trim().length > 0) {
      targetPaths.push(rawTarget.trim());
    } else if (Array.isArray(rawTarget)) {
      for (const t of rawTarget) {
        if (typeof t === 'string' && t.trim().length > 0) targetPaths.push(t.trim());
      }
    }

    // ------------------------------------------------------------------------
    // 1. CRITICAL Evaluation: Irreversible, system-wide, or outside-root access
    // ------------------------------------------------------------------------

    // Project root escape check
    for (const tp of targetPaths) {
      if (isPathEscapingRoot(tp, projectRoot)) {
        return RiskLevel.CRITICAL;
      }
    }

    // Explicit CRITICAL action types
    if (
      action === OperationActionType.WORKSPACE_ESCAPE ||
      action === OperationActionType.BULK_DELETION ||
      action === OperationActionType.GIT_FORCE_PUSH ||
      action === OperationActionType.GIT_BRANCH_DELETION ||
      action === OperationActionType.CREDENTIAL_EXFILTRATION ||
      action === OperationActionType.SYSTEM_DESTRUCTIVE ||
      action === OperationActionType.SERVICE_CONTROL ||
      action === OperationActionType.DISK_PARTITION
    ) {
      return RiskLevel.CRITICAL;
    }

    // Bulk deletion command
    if (cmd && isBulkDeletionCommand(cmd)) {
      return RiskLevel.CRITICAL;
    }

    // OS destructive command
    if (cmd && isOsDestructiveCommand(cmd)) {
      return RiskLevel.CRITICAL;
    }

    // Git force push command
    if (cmd && isGitForcePushCommand(cmd)) {
      return RiskLevel.CRITICAL;
    }

    // Git remote branch deletion command
    if (cmd && isGitRemoteDeletionCommand(cmd)) {
      return RiskLevel.CRITICAL;
    }

    // Credential / secret exfiltration pattern
    if (isCredentialExfiltration(request, cmd)) {
      return RiskLevel.CRITICAL;
    }

    // ------------------------------------------------------------------------
    // 2. DANGEROUS Evaluation: Config changes, dependency installs, migrations
    // ------------------------------------------------------------------------

    if (
      action === OperationActionType.DEPENDENCY_INSTALL ||
      action === OperationActionType.PACKAGE_CONFIG_MUTATION ||
      action === OperationActionType.DB_MIGRATION ||
      action === OperationActionType.ENVIRONMENT_CONFIG ||
      action === OperationActionType.GIT_RESET ||
      action === OperationActionType.GIT_ROLLBACK ||
      request.changes_dependencies === true ||
      request.changesDependencies === true ||
      request.mutates_config === true ||
      request.mutatesConfig === true
    ) {
      return RiskLevel.DANGEROUS;
    }

    if (cmd && isDependencyInstallationCommand(cmd)) {
      return RiskLevel.DANGEROUS;
    }

    if (cmd && /\b(prisma|typeorm|alembic|knex|flyway|liquibase)\s+(migrate|migration|upgrade)\b/i.test(cmd)) {
      return RiskLevel.DANGEROUS;
    }

    if (cmd && /\bgit\s+(reset|revert)\b/i.test(cmd)) {
      return RiskLevel.DANGEROUS;
    }

    for (const tp of targetPaths) {
      if (isPackageOrConfigPath(tp)) {
        return RiskLevel.DANGEROUS;
      }
    }

    // ------------------------------------------------------------------------
    // 3. CAUTION Evaluation: Normal source modifications, builds, test execution
    // ------------------------------------------------------------------------

    if (
      action === OperationActionType.FILE_CREATE ||
      action === OperationActionType.FILE_MODIFY ||
      action === OperationActionType.SOURCE_MUTATION ||
      action === OperationActionType.BUILD_EXECUTION ||
      action === OperationActionType.TEST_EXECUTION ||
      request.mutates_source === true ||
      request.mutatesSource === true
    ) {
      return RiskLevel.CAUTION;
    }

    if (
      cmd &&
      /\b(npm|pnpm|yarn|cargo|pytest|go|vitest|jest)\s+(test|build|run\s+build|run\s+test)\b/i.test(cmd)
    ) {
      return RiskLevel.CAUTION;
    }

    if (cmd && /\b(tsc|gcc|clang|cargo\s+build)\b/i.test(cmd)) {
      return RiskLevel.CAUTION;
    }

    // ------------------------------------------------------------------------
    // 4. SAFE Evaluation: Read-only, inspection, search, status checks
    // ------------------------------------------------------------------------

    if (
      action === OperationActionType.FILE_READ ||
      action === OperationActionType.DIRECTORY_LIST ||
      action === OperationActionType.WORKSPACE_SEARCH ||
      action === OperationActionType.GIT_STATUS ||
      action === OperationActionType.GIT_INSPECT ||
      action === OperationActionType.LINT_EXECUTION ||
      action === OperationActionType.READ_ONLY_INSPECTION ||
      request.is_read_only === true ||
      request.isReadOnly === true
    ) {
      return RiskLevel.SAFE;
    }

    if (cmd && /\bgit\s+(status|log|diff|branch|rev-parse)\b/i.test(cmd)) {
      return RiskLevel.SAFE;
    }

    if (cmd && /\b(cat|type|ls|dir|grep|find|eslint)\b/i.test(cmd)) {
      return RiskLevel.SAFE;
    }

    // Fall back to requested_risk_level if provided, else CAUTION for recognized mutation, SAFE for read-only
    const requested = request.requested_risk_level ?? request.requestedRiskLevel;
    if (requested && isRiskLevel(requested)) {
      return requested;
    }

    return RiskLevel.CAUTION;
  }

  /**
   * Alias for classifyOperation.
   */
  classifyRisk(request: PolicyOperationRequest): RiskLevel {
    return this.classifyOperation(request);
  }

  /**
   * Evaluates an operation request and renders a structured, deterministic PolicyDecision.
   */
  evaluate(
    request: PolicyOperationRequest,
    configOverride?: Partial<PolicyEngineConfig>
  ): PolicyDecision {
    const evaluatedAt = new Date().toISOString();
    const config: PolicyEngineConfig = Object.freeze({
      ...this.config,
      ...configOverride,
    });

    // ------------------------------------------------------------------------
    // 1. Fail Closed: Malformed or missing request
    // ------------------------------------------------------------------------
    if (!request || typeof request !== 'object') {
      return Object.freeze({
        allowed: false,
        decision: PolicyDecisionState.DENY,
        risk_level: RiskLevel.CRITICAL,
        code: 'MALFORMED_OPERATION_REQUEST',
        reason: 'Operation request is missing, null, or malformed',
        reasons: Object.freeze(['Operation request is missing, null, or malformed']),
        requires_human_authorization: false,
        violations: Object.freeze([
          { code: 'MALFORMED_REQUEST', message: 'Request is null or not an object' },
        ]),
        evaluated_at: evaluatedAt,
        riskLevel: RiskLevel.CRITICAL,
        requiresHumanAuthorization: false,
        evaluatedAt,
      });
    }

    const action = request.action_type ?? request.actionType;
    const cmd = (request.command ?? '').trim();
    const projectRoot =
      request.project_root ??
      request.projectRoot ??
      config.project_root ??
      config.projectRoot ??
      process.cwd();
    const rawTarget = request.target_path ?? request.targetPath;
    const targetPaths: string[] = [];
    if (typeof rawTarget === 'string' && rawTarget.trim().length > 0) {
      targetPaths.push(rawTarget.trim());
    } else if (Array.isArray(rawTarget)) {
      for (const t of rawTarget) {
        if (typeof t === 'string' && t.trim().length > 0) targetPaths.push(t.trim());
      }
    }

    // Fail closed if operation has neither action, command, nor target
    if (!action && !cmd && targetPaths.length === 0) {
      return Object.freeze({
        allowed: false,
        decision: PolicyDecisionState.DENY,
        risk_level: RiskLevel.CRITICAL,
        code: 'EMPTY_OPERATION_REQUEST',
        reason: 'Operation request lacks action type, command, and target descriptor',
        reasons: Object.freeze(['Operation request lacks action type, command, and target descriptor']),
        requires_human_authorization: false,
        violations: Object.freeze([
          { code: 'EMPTY_REQUEST', message: 'No action, command, or target specified' },
        ]),
        evaluated_at: evaluatedAt,
        riskLevel: RiskLevel.CRITICAL,
        requiresHumanAuthorization: false,
        evaluatedAt,
      });
    }

    // ------------------------------------------------------------------------
    // 2. Classify Risk Level
    // ------------------------------------------------------------------------
    const riskLevel = this.classifyOperation(request);
    const violations: PolicyViolationItem[] = [];
    const reasons: string[] = [];

    // Check project root escape
    for (const tp of targetPaths) {
      if (isPathEscapingRoot(tp, projectRoot)) {
        violations.push({
          code: 'WORKSPACE_ESCAPE_ATTEMPT',
          message: `Target path '${tp}' escapes project root boundary`,
          field: 'target_path',
        });
        reasons.push(`Target path escapes project root '${projectRoot}'`);
      }
    }

    // ------------------------------------------------------------------------
    // 3. Git-Specific Delegation to GitPolicyValidator
    // ------------------------------------------------------------------------
    const affectsGit =
      request.affects_git === true ||
      request.affectsGit === true ||
      action === OperationActionType.GIT_STATUS ||
      action === OperationActionType.GIT_INSPECT ||
      action === OperationActionType.GIT_RESET ||
      action === OperationActionType.GIT_ROLLBACK ||
      action === OperationActionType.GIT_FORCE_PUSH ||
      action === OperationActionType.GIT_BRANCH_DELETION ||
      (cmd && cmd.startsWith('git '));

    let evaluatedGitDecision: GitPolicyDecision | undefined;

    if (affectsGit) {
      let gitOp: GitOperationType = GitOperationType.STATUS_INSPECTION;
      if (isGitForcePushCommand(cmd) || action === OperationActionType.GIT_FORCE_PUSH) {
        gitOp = GitOperationType.FORCE_PUSH;
      } else if (isGitRemoteDeletionCommand(cmd) || action === OperationActionType.GIT_BRANCH_DELETION) {
        gitOp = GitOperationType.DESTRUCTIVE_REMOTE_REWRITE;
      } else if (/\bgit\s+reset\b/i.test(cmd) || action === OperationActionType.GIT_RESET) {
        gitOp = GitOperationType.RESET;
      } else if (/\bgit\s+checkout\b/i.test(cmd)) {
        gitOp = GitOperationType.CHECKOUT;
      } else if (/\bgit\s+commit\b/i.test(cmd)) {
        gitOp = GitOperationType.COMMIT;
      } else if (/\bgit\s+push\b/i.test(cmd)) {
        gitOp = GitOperationType.PUSH;
      } else {
        gitOp = GitOperationType.STATUS_INSPECTION;
      }

      const gitIntent: GitOperationIntent = {
        operation: gitOp,
        target_branch: 'main',
        force: isGitForcePushCommand(cmd),
        human_approval_token: request.human_approval_token ?? request.humanApprovalToken ?? null,
      };

      const syntheticState = createGitState({
        head_sha: '0000000000000000000000000000000000000001',
        current_branch: 'main',
        working_tree_clean: true,
      });

      const gitDecision = this.gitPolicyValidator.validateOperation(gitIntent, syntheticState);
      evaluatedGitDecision = gitDecision;

      if (!gitDecision.allowed) {
        const isForcePush = gitOp === GitOperationType.FORCE_PUSH || gitDecision.violations.some((v) => v.code === 'FORCE_PUSH_PROHIBITED');
        const code = isForcePush
          ? 'GIT_FORCE_PUSH_PROHIBITED'
          : gitDecision.violations[0]?.code ?? 'GIT_POLICY_VIOLATION';

        return Object.freeze({
          allowed: false,
          decision: gitDecision.requires_human_approval
            ? PolicyDecisionState.REQUIRE_HUMAN
            : PolicyDecisionState.DENY,
          risk_level: gitDecision.risk_level,
          code: String(code),
          reason: sanitizeMessage(gitDecision.reasons.join('; ')),
          reasons: Object.freeze(gitDecision.reasons.map(sanitizeMessage)),
          requires_human_authorization: gitDecision.requires_human_approval,
          action_type: action ? String(action) : undefined,
          violations: Object.freeze([
            ...violations,
            ...gitDecision.violations.map((v) => ({
              code: String(v.code),
              message: sanitizeMessage(v.message),
              field: v.field,
            })),
          ]),
          evaluated_at: evaluatedAt,
          git_policy_decision: gitDecision,
          riskLevel: gitDecision.risk_level,
          requiresHumanAuthorization: gitDecision.requires_human_approval,
          actionType: action ? String(action) : undefined,
          evaluatedAt,
          gitPolicyDecision: gitDecision,
        });
      } else if (riskLevel !== RiskLevel.CRITICAL) {
        return Object.freeze({
          allowed: true,
          decision: PolicyDecisionState.ALLOW,
          risk_level: gitDecision.risk_level,
          code: 'GIT_OPERATION_ALLOWED',
          reason: sanitizeMessage(gitDecision.reasons.join('; ') || 'Git operation permitted by git policy boundary'),
          reasons: Object.freeze(gitDecision.reasons.map(sanitizeMessage)),
          requires_human_authorization: false,
          action_type: action ? String(action) : undefined,
          violations: Object.freeze([...violations]),
          evaluated_at: evaluatedAt,
          git_policy_decision: gitDecision,
          riskLevel: gitDecision.risk_level,
          requiresHumanAuthorization: false,
          actionType: action ? String(action) : undefined,
          evaluatedAt,
          gitPolicyDecision: gitDecision,
        });
      }
    }

    // ------------------------------------------------------------------------
    // 4. Handle CRITICAL Risk Level: Strict Human Authorization Required
    // ------------------------------------------------------------------------
    if (riskLevel === RiskLevel.CRITICAL) {
      if (cmd && isBulkDeletionCommand(cmd)) {
        violations.push({
          code: 'BULK_DELETION_DETECTED',
          message: 'Bulk directory/filesystem deletion detected',
          field: 'command',
        });
        reasons.push('Bulk filesystem deletion is a CRITICAL operation');
      }

      if (cmd && isOsDestructiveCommand(cmd)) {
        violations.push({
          code: 'OS_DESTRUCTIVE_OPERATION',
          message: 'OS-level service control, disk partitioning, or formatting detected',
          field: 'command',
        });
        reasons.push('OS-level destructive operation is CRITICAL');
      }

      if (isCredentialExfiltration(request, cmd)) {
        violations.push({
          code: 'CREDENTIAL_EXFILTRATION_PATTERN',
          message: 'Suspected credential or secret transmission to external addresses',
          field: 'command',
        });
        reasons.push('Credential/secret exfiltration pattern is CRITICAL');
      }

      // Check for human authorization token (Untrusted flags like --dangerously-skip-permissions are rejected)
      const token = (
        request.human_approval_token ??
        request.humanApprovalToken ??
        ''
      ).trim();

      if (!token) {
        return Object.freeze({
          allowed: false,
          decision: PolicyDecisionState.REQUIRE_HUMAN,
          risk_level: RiskLevel.CRITICAL,
          code: 'HUMAN_AUTHORIZATION_REQUIRED',
          reason: sanitizeMessage(
            `Operation classified as CRITICAL and requires explicit human authorization: ${
              reasons.join('; ') || 'Critical operation'
            }`
          ),
          reasons: Object.freeze(reasons.map(sanitizeMessage)),
          requires_human_authorization: true,
          action_type: action ? String(action) : undefined,
          violations: Object.freeze(violations),
          evaluated_at: evaluatedAt,
          git_policy_decision: evaluatedGitDecision,
          riskLevel: RiskLevel.CRITICAL,
          requiresHumanAuthorization: true,
          actionType: action ? String(action) : undefined,
          evaluatedAt,
          gitPolicyDecision: evaluatedGitDecision,
        });
      }

      // If token validator is configured, invoke it
      if (config.validateHumanApprovalToken) {
        const valRes = config.validateHumanApprovalToken(token);
        const isValid = typeof valRes === 'boolean' ? valRes : valRes.valid;
        if (!isValid) {
          const rejectReason =
            typeof valRes === 'object' && valRes.reason
              ? valRes.reason
              : 'Human authorization token validation failed';
          return Object.freeze({
            allowed: false,
            decision: PolicyDecisionState.REQUIRE_HUMAN,
            risk_level: RiskLevel.CRITICAL,
            code: 'INVALID_HUMAN_APPROVAL_TOKEN',
            reason: sanitizeMessage(rejectReason),
            reasons: Object.freeze([sanitizeMessage(rejectReason)]),
            requires_human_authorization: true,
            action_type: action ? String(action) : undefined,
            violations: Object.freeze([
              ...violations,
              { code: 'INVALID_TOKEN', message: sanitizeMessage(rejectReason) },
            ]),
            evaluated_at: evaluatedAt,
            git_policy_decision: evaluatedGitDecision,
            riskLevel: RiskLevel.CRITICAL,
            requiresHumanAuthorization: true,
            actionType: action ? String(action) : undefined,
            evaluatedAt,
            gitPolicyDecision: evaluatedGitDecision,
          });
        }
      }

      // Valid human authorization provided
      return Object.freeze({
        allowed: true,
        decision: PolicyDecisionState.ALLOW,
        risk_level: RiskLevel.CRITICAL,
        code: 'CRITICAL_OPERATION_AUTHORIZED_BY_HUMAN',
        reason: 'CRITICAL operation authorized by verified human approval token',
        reasons: Object.freeze(['CRITICAL operation authorized by verified human approval token']),
        requires_human_authorization: true,
        action_type: action ? String(action) : undefined,
        violations: Object.freeze(violations),
        evaluated_at: evaluatedAt,
        git_policy_decision: evaluatedGitDecision,
        riskLevel: RiskLevel.CRITICAL,
        requiresHumanAuthorization: true,
        actionType: action ? String(action) : undefined,
        evaluatedAt,
        gitPolicyDecision: evaluatedGitDecision,
      });
    }

    // ------------------------------------------------------------------------
    // 5. Handle DANGEROUS Risk Level: Allowed under project constraints
    // ------------------------------------------------------------------------
    if (riskLevel === RiskLevel.DANGEROUS) {
      const requireHuman =
        config.require_human_for_dangerous ?? config.requireHumanForDangerous ?? false;
      const allowDangerous =
        config.allow_dangerous_operations ?? config.allowDangerousOperations ?? true;
      const isDepInstall =
        action === OperationActionType.DEPENDENCY_INSTALL ||
        request.changes_dependencies === true ||
        request.changesDependencies === true ||
        (cmd && isDependencyInstallationCommand(cmd));
      const allowDep =
        config.allow_dependency_installation ?? config.allowDependencyInstallation ?? true;

      if (isDepInstall && !allowDep) {
        return Object.freeze({
          allowed: false,
          decision: PolicyDecisionState.DENY,
          risk_level: RiskLevel.DANGEROUS,
          code: 'DEPENDENCY_INSTALLATION_DISALLOWED',
          reason: 'Dependency installation is disabled by project policy config',
          reasons: Object.freeze(['Dependency installation is disabled by project policy config']),
          requires_human_authorization: false,
          action_type: action ? String(action) : undefined,
          evaluated_at: evaluatedAt,
          riskLevel: RiskLevel.DANGEROUS,
          requiresHumanAuthorization: false,
          actionType: action ? String(action) : undefined,
          evaluatedAt,
        });
      }

      if (!allowDangerous) {
        return Object.freeze({
          allowed: false,
          decision: PolicyDecisionState.DENY,
          risk_level: RiskLevel.DANGEROUS,
          code: 'DANGEROUS_OPERATIONS_DISALLOWED',
          reason: 'Dangerous operations are disabled by project policy config',
          reasons: Object.freeze(['Dangerous operations are disabled by project policy config']),
          requires_human_authorization: false,
          action_type: action ? String(action) : undefined,
          evaluated_at: evaluatedAt,
          riskLevel: RiskLevel.DANGEROUS,
          requiresHumanAuthorization: false,
          actionType: action ? String(action) : undefined,
          evaluatedAt,
        });
      }

      if (requireHuman) {
        const token = (
          request.human_approval_token ??
          request.humanApprovalToken ??
          ''
        ).trim();
        if (!token) {
          return Object.freeze({
            allowed: false,
            decision: PolicyDecisionState.REQUIRE_HUMAN,
            risk_level: RiskLevel.DANGEROUS,
            code: 'HUMAN_AUTHORIZATION_REQUIRED',
            reason: 'DANGEROUS operation requires explicit human authorization under current policy config',
            reasons: Object.freeze(['DANGEROUS operation requires explicit human authorization under current policy config']),
            requires_human_authorization: true,
            action_type: action ? String(action) : undefined,
            evaluated_at: evaluatedAt,
            riskLevel: RiskLevel.DANGEROUS,
            requiresHumanAuthorization: true,
            actionType: action ? String(action) : undefined,
            evaluatedAt,
          });
        }
      }

      // Permitted under project policy constraints
      const reasonMsg = isDepInstall
        ? 'Dependency installation classified as DANGEROUS; permitted under project policy'
        : 'Configuration mutation classified as DANGEROUS; permitted under project policy';

      return Object.freeze({
        allowed: true,
        decision: PolicyDecisionState.ALLOW,
        risk_level: RiskLevel.DANGEROUS,
        code: isDepInstall ? 'DEPENDENCY_INSTALLATION_ALLOWED' : 'DANGEROUS_OPERATION_ALLOWED',
        reason: reasonMsg,
        reasons: Object.freeze([reasonMsg]),
        requires_human_authorization: false,
        action_type: action ? String(action) : undefined,
        evaluated_at: evaluatedAt,
        riskLevel: RiskLevel.DANGEROUS,
        requiresHumanAuthorization: false,
        actionType: action ? String(action) : undefined,
        evaluatedAt,
      });
    }

    // ------------------------------------------------------------------------
    // 6. Handle CAUTION Risk Level: Normal source modifications & tests
    // ------------------------------------------------------------------------
    if (riskLevel === RiskLevel.CAUTION) {
      return Object.freeze({
        allowed: true,
        decision: PolicyDecisionState.ALLOW,
        risk_level: RiskLevel.CAUTION,
        code: 'CAUTION_OPERATION_ALLOWED',
        reason: 'Normal development operation permitted within project workspace',
        reasons: Object.freeze(['Normal development operation permitted within project workspace']),
        requires_human_authorization: false,
        action_type: action ? String(action) : undefined,
        evaluated_at: evaluatedAt,
        riskLevel: RiskLevel.CAUTION,
        requiresHumanAuthorization: false,
        actionType: action ? String(action) : undefined,
        evaluatedAt,
      });
    }

    // ------------------------------------------------------------------------
    // 7. Handle SAFE Risk Level: Read-only, inspection, search
    // ------------------------------------------------------------------------
    return Object.freeze({
      allowed: true,
      decision: PolicyDecisionState.ALLOW,
      risk_level: RiskLevel.SAFE,
      code: 'SAFE_OPERATION_ALLOWED',
      reason: 'Read-only / inspection operation automatically allowed',
      reasons: Object.freeze(['Read-only / inspection operation automatically allowed']),
      requires_human_authorization: false,
      action_type: action ? String(action) : undefined,
      evaluated_at: evaluatedAt,
      riskLevel: RiskLevel.SAFE,
      requiresHumanAuthorization: false,
      actionType: action ? String(action) : undefined,
      evaluatedAt,
    });
  }

  /**
   * Convenience validation method returning true if permitted without human intervention.
   */
  isAllowed(
    request: PolicyOperationRequest,
    configOverride?: Partial<PolicyEngineConfig>
  ): boolean {
    return this.evaluate(request, configOverride).allowed;
  }
}

/**
 * Convenience alias for PolicyEngine.
 */
export const AIDMPolicyEngine = PolicyEngine;
export type AIDMPolicyEngine = PolicyEngine;
