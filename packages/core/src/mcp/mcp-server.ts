/**
 * MCP Server Implementation (Phase 8 TASK-P8-01)
 *
 * Establishes the authoritative MCP-compatible server boundary for AIDM.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. MCP is a control-plane adapter sitting strictly ABOVE the AIDM Orchestrator.
 * 2. MCP is NOT a second orchestrator. It does not own or mutate an FSM, task DAG,
 *    Git, or evidence.
 * 3. All operations pass through the delegate boundary and policy engine.
 * 4. Error responses are normalized, typed, and secret-redacted.
 * 5. Deterministic request correlation is tracked for every request.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type McpServerConfig,
  type McpServerCapabilities,
  type McpMessage,
  type McpRequestEnvelope,
  type McpResponseEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
  type McpToolDefinition,
  type McpToolHandler,
  type McpToolRegistration,
  type McpInitializeResult,
  McpServerState,
  LATEST_MCP_PROTOCOL_VERSION,
  MCP_FOUNDATION_VERSION,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_MCP_SERVER_VERSION,
  DEFAULT_AIDM_VERSION,
  isMcpRequest,
  isMcpNotification,
} from './mcp-types.js';
import type { McpTransport } from './mcp-transport.js';
import { DefaultMcpOrchestratorDelegate, type McpOrchestratorDelegate } from './mcp-delegate.js';
import type { PolicyEngine } from '../policy/policy-engine.js';
import {
  McpErrorNormalizer,
  McpInvalidRequestError,
  McpUnsupportedOperationError,
  McpPolicyBlockedError,
  McpJsonRpcErrorCode,
  McpErrorCode,
} from './mcp-errors.js';
import {
  createRequestCorrelation,
  type McpRequestCorrelation,
} from './mcp-correlation.js';
import {
  createCollisionSafeToolName,
  isValidMcpToolName,
  MCP_TOOL_NAME_REGEX,
} from './tool-name-mapper.js';
import { createHealthTool } from './tools/health-tool.js';
import {
  registerDirectorReadTools,
  registerDiscoveryTools,
  registerCompletenessTools,
  registerRequirementsScopeTools,
  registerArchitectureTechnologyTools,
  registerBusinessRulesTools,
  registerAcceptanceCriteriaTools,
  registerRiskHumanDecisionTools,
  registerProjectSpecTools,
} from './tools/director-read-tools.js';
import { registerClarificationTools } from './tools/clarification-tools.js';
import { registerApprovalTools } from './tools/approval-tools.js';
import { registerDirectorSessionTools } from './tools/director-session-tools.js';
import { registerDirectorDecisionTools } from './tools/director-decision-tools.js';
import { registerHumanApprovalTools } from './tools/human-approval-tools.js';
import { registerExecutionIntentTools } from './tools/execution-intent-tools.js';
import { registerExecutionRequestTools } from './tools/execution-request-tools.js';
import { registerExecutorTools } from './tools/executor-tools.js';
import { registerEvidenceVerifyTools } from './tools/evidence-verify-tool.js';
import { registerPhase11ContinuationTools } from './tools/phase11-continuation-tool.js';
import { registerTaskDecompositionTools } from './tools/task-decomposition-tools.js';
import { registerRetryAuthorizeTools } from './tools/retry-authorize-tool.js';
import { registerCorrectiveTaskTools } from './tools/corrective-task-tool.js';
import { registerRecoveryEvaluateTools } from './tools/recovery-evaluate-tool.js';
import { registerExecutorContextTools } from './tools/executor-context-tool.js';
import { registerDirectorLoopTools } from './tools/director-loop-tools.js';
import { registerDriverTools } from './tools/driver-tools.js';
import { registerDirectorControlPlaneTools } from './tools/director-control-plane-tools.js';
import { classifyMcpTool } from './tool-policy-classifier.js';
import { createMcpAuthMiddleware } from './director-mcp-client.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';


export class McpServer {
  readonly name: string;
  readonly version: string;
  readonly aidmVersion: string;
  readonly foundationVersion: string;
  readonly transport: McpTransport;
  readonly delegate?: McpOrchestratorDelegate;
  readonly policyEngine?: PolicyEngine;
  readonly capabilities: McpServerCapabilities;
  readonly instructions?: string;

  private state: McpServerState = McpServerState.CREATED;
  private readonly toolRegistry = new Map<string, McpToolRegistration>();
  private readonly exposedTools = new Map<string, McpToolRegistration>();
  private readonly correlationGenerator?: () => string;
  private readonly authMiddleware?: (rawMessage: unknown) => { allowed: boolean; reason?: string };
  private clientInitialized = false;
  private listenersAttached = false;

  constructor(config: McpServerConfig) {
    this.name = config.name ?? DEFAULT_MCP_SERVER_NAME;
    this.version = config.version ?? DEFAULT_MCP_SERVER_VERSION;
    this.aidmVersion = config.aidmVersion ?? DEFAULT_AIDM_VERSION;
    this.foundationVersion = config.foundationVersion ?? MCP_FOUNDATION_VERSION;
    this.transport = config.transport;
    this.delegate = config.delegate;
    this.policyEngine = config.policyEngine ?? config.delegate?.policyEngine;
    this.capabilities = Object.freeze({
      tools: { listChanged: false },
      ...config.capabilities,
    });
    this.instructions = config.instructions;
    this.correlationGenerator = config.correlationGenerator;
    this.authMiddleware =
      config.authMiddleware ??
      (config.authToken ? createMcpAuthMiddleware({ requiredToken: config.authToken }) : undefined);

    // Register minimal health & capability discovery tool
    const healthTool = createHealthTool({
      serverName: this.name,
      serverVersion: this.version,
      aidmVersion: this.aidmVersion,
    });
    this.registerTool(healthTool.definition, healthTool.handler);

    // Register Director read-only tools if enabled
    if (config.directorTools) {
      registerDirectorReadTools(this);
    }

    // Register Director project discovery tool if enabled
    if (config.discoveryTools) {
      registerDiscoveryTools(this);
    }

    // Register Specification completeness evaluation tool if enabled
    if (config.completenessTools) {
      registerCompletenessTools(this);
    }

    // Register Requirements & Scope tools if enabled
    if (config.requirementsScopeTools) {
      registerRequirementsScopeTools(this);
    }

    // Register Architecture & Technology tools if enabled
    if (config.architectureTools) {
      registerArchitectureTechnologyTools(this);
    }

    // Register Business Rules tools if enabled
    if (config.businessRulesTools) {
      registerBusinessRulesTools(this);
    }

    // Register Acceptance Criteria tools if enabled
    if (config.acceptanceCriteriaTools) {
      registerAcceptanceCriteriaTools(this);
    }

    // Register Risk & Human Decision Points tools if enabled
    if (config.riskTools) {
      registerRiskHumanDecisionTools(this);
    }

    // Register Project Spec tools if enabled
    if (config.projectSpecTools) {
      registerProjectSpecTools(this);
    }

    // Register Director clarification protocol tools if enabled
    if (config.clarificationTools) {
      registerClarificationTools(this);
    }

    // Register Director approval gate tools if enabled
    if (config.approvalTools) {
      registerApprovalTools(this);
    }

    // Register Director session identity tools if enabled
    if (config.directorSessionTools) {
      registerDirectorSessionTools(this);
    }

    // Register Director decision protocol tools if enabled
    if (config.directorDecisionTools) {
      registerDirectorDecisionTools(this);
    }

    // Register Human approval & resume protocol tools if enabled
    if (config.humanApprovalTools) {
      registerHumanApprovalTools(this);
    }

    // Register Execution intent authorization boundary tools if enabled
    if (config.executionIntentTools) {
      registerExecutionIntentTools(this);
    }

    // Register Execution request contract tools if enabled
    if (config.executionRequestTools) {
      registerExecutionRequestTools(this);
    }

    // Register Executor adapter boundary tools if enabled
    if (config.executorTools) {
      registerExecutorTools(this);
    }

    // Register Evidence verification pipeline tools if enabled
    if (config.evidenceVerifyTools) {
      registerEvidenceVerifyTools(this);
    }

    // Register Phase 11 Controlled Continuation boundary tools if enabled
    if (config.phase11ContinuationTools) {
      registerPhase11ContinuationTools(this);
    }

    // Register Phase 12 Task Decomposition boundary tools if enabled
    if (config.taskDecompositionTools) {
      registerTaskDecompositionTools(this);
    }

    // Register Phase 13 Recovery Evaluation boundary tools if enabled
    if (config.recoveryTools || config.recoveryEvaluateTools) {
      registerRecoveryEvaluateTools(this);
    }

    // Register Phase 13 Task Retry Authorization boundary tools if enabled
    if (config.retryAuthorizeTools || config.recoveryTools) {
      registerRetryAuthorizeTools(this);
    }

    // Register Phase 13 Corrective Task Lineage boundary tools if enabled
    if (config.correctiveTaskTools || config.recoveryTools) {
      registerCorrectiveTaskTools(this);
    }

    // Register Executor Context Package tools if enabled
    if (config.executorContextTools || config.executorTools) {
      registerExecutorContextTools(this);
    }

    // Register Director Loop tools if enabled
    if (config.directorLoopTools) {
      registerDirectorLoopTools(this);
    }

    // Register Autonomous Driver tools if enabled
    if (config.driverTools) {
      registerDriverTools(this);
    }

    // Register Phase 22 Director MCP Control Plane tools if enabled
    if (config.directorControlPlaneTools) {
      registerDirectorControlPlaneTools(this);
    }
  }


  // ==========================================================================
  // LIFECYCLE MANAGEMENT
  // ==========================================================================

  getState(): McpServerState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state === McpServerState.RUNNING;
  }

  async start(): Promise<void> {
    if (this.state === McpServerState.RUNNING || this.state === McpServerState.STARTING) {
      return;
    }

    this.state = McpServerState.STARTING;

    if (!this.listenersAttached) {
      this.transport.onMessage(async (message: McpMessage) => {
        try {
          const response = await this.handleMessage(message);
          if (response && this.transport.isConnected) {
            await this.transport.send(response);
          }
        } catch (err) {
          // Transport-level sending error
          this.state = McpServerState.ERROR;
        }
      });

      this.transport.onError((_err: Error) => {
        // Keep running or transition to error depending on severity
      });

      this.transport.onClose(() => {
        if (this.state === McpServerState.RUNNING || this.state === McpServerState.STARTING) {
          this.state = McpServerState.STOPPED;
        }
      });
      this.listenersAttached = true;
    }

    await this.transport.start();
    this.state = McpServerState.RUNNING;
  }

  async stop(): Promise<void> {
    if (this.state === McpServerState.STOPPED) {
      return;
    }

    this.state = McpServerState.STOPPING;
    this.clientInitialized = false;

    if (this.transport.isConnected) {
      await this.transport.close();
    }

    this.state = McpServerState.STOPPED;
  }

  // ==========================================================================
  // TOOL REGISTRATION
  // ==========================================================================

  registerTool(definition: McpToolDefinition, handler: McpToolHandler): void {
    if (!definition || !definition.name || typeof definition.name !== 'string' || definition.name.trim().length === 0) {
      throw new McpInvalidRequestError('Tool definition must specify a valid name');
    }
    if (typeof definition.description !== 'string') {
      throw new McpInvalidRequestError('Tool definition must specify a description');
    }
    if (!definition.inputSchema || typeof definition.inputSchema !== 'object') {
      throw new McpInvalidRequestError('Tool definition must specify a valid inputSchema');
    }

    const internalName = definition.name;
    const existingExposedNames = new Set(this.exposedTools.keys());
    const exposedName = createCollisionSafeToolName(internalName, existingExposedNames);

    if (!isValidMcpToolName(exposedName)) {
      throw new McpInvalidRequestError(
        `Normalized tool name "${exposedName}" violates MCP naming specification ${MCP_TOOL_NAME_REGEX}`
      );
    }

    const exposedDefinition: McpToolDefinition = Object.freeze({
      ...definition,
      name: exposedName,
      internalName,
    });

    const registration: McpToolRegistration = Object.freeze({
      definition: exposedDefinition,
      handler,
      internalName,
      exposedName,
    });

    this.exposedTools.set(exposedName, registration);
    this.toolRegistry.set(exposedName, registration);
    if (internalName !== exposedName) {
      this.toolRegistry.set(internalName, registration);
    }
  }

  getRegisteredTools(): readonly McpToolDefinition[] {
    return Array.from(this.exposedTools.values()).map((r) => r.definition);
  }

  getTool(name: string): McpToolRegistration | undefined {
    return this.toolRegistry.get(name);
  }

  private validateToolInputSchema(
    definition: McpToolDefinition,
    args: Record<string, unknown>,
    correlationId: string
  ): void {
    const schema = definition.inputSchema;
    if (!schema || typeof schema !== 'object') {
      return;
    }

    // Check required fields
    if (Array.isArray(schema.required)) {
      for (const requiredField of schema.required) {
        if (typeof requiredField === 'string' && (args[requiredField] === undefined || args[requiredField] === null)) {
          throw new McpInvalidRequestError(
            `Missing required argument "${requiredField}" for tool "${definition.name}"`,
            { toolName: definition.name, missingArgument: requiredField },
            correlationId
          );
        }
      }
    }

    // Check property types
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [propName, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
        const val = args[propName];
        if (val === undefined || val === null) {
          continue;
        }

        if (propSchema.type) {
          switch (propSchema.type) {
            case 'string':
              if (typeof val !== 'string') {
                throw new McpInvalidRequestError(
                  `Argument "${propName}" for tool "${definition.name}" must be a string, got ${typeof val}`,
                  { toolName: definition.name, argument: propName, expectedType: 'string', actualType: typeof val },
                  correlationId
                );
              }
              break;
            case 'number':
              if (typeof val !== 'number' || Number.isNaN(val)) {
                throw new McpInvalidRequestError(
                  `Argument "${propName}" for tool "${definition.name}" must be a number, got ${typeof val}`,
                  { toolName: definition.name, argument: propName, expectedType: 'number', actualType: typeof val },
                  correlationId
                );
              }
              break;
            case 'boolean':
              if (typeof val !== 'boolean') {
                throw new McpInvalidRequestError(
                  `Argument "${propName}" for tool "${definition.name}" must be a boolean, got ${typeof val}`,
                  { toolName: definition.name, argument: propName, expectedType: 'boolean', actualType: typeof val },
                  correlationId
                );
              }
              break;
            case 'array':
              if (!Array.isArray(val)) {
                throw new McpInvalidRequestError(
                  `Argument "${propName}" for tool "${definition.name}" must be an array, got ${typeof val}`,
                  { toolName: definition.name, argument: propName, expectedType: 'array' },
                  correlationId
                );
              }
              break;
            case 'object':
              if (typeof val !== 'object' || val === null || Array.isArray(val)) {
                throw new McpInvalidRequestError(
                  `Argument "${propName}" for tool "${definition.name}" must be an object, got ${typeof val}`,
                  { toolName: definition.name, argument: propName, expectedType: 'object' },
                  correlationId
                );
              }
              break;
          }
        }
      }
    }
  }

  // ==========================================================================
  // MESSAGE PROCESSING & ENVELOPE BOUNDARY
  // ==========================================================================

  async handleMessage(rawMessage: unknown): Promise<McpResponseEnvelope | null> {
    // 1. Validate envelope structure
    if (typeof rawMessage !== 'object' || rawMessage === null) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: McpJsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid MCP JSON-RPC message: payload must be a non-null object',
          data: { code: McpErrorCode.INVALID_REQUEST },
        },
      };
    }

    const msg = rawMessage as Record<string, unknown>;

    // Handle synthetic malformed JSON notification from transport
    if (msg.method === '__malformed_json__') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: McpJsonRpcErrorCode.PARSE_ERROR,
          message: 'Parse error: invalid JSON received',
          data: { code: McpErrorCode.PARSE_ERROR },
        },
      };
    }

    if (msg.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null,
        error: {
          code: McpJsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid MCP JSON-RPC message: "jsonrpc" must be exact string "2.0"',
          data: { code: McpErrorCode.INVALID_REQUEST },
        },
      };
    }

    // Optional external auth middleware verification
    if (this.authMiddleware) {
      const authDecision = this.authMiddleware(rawMessage);
      if (!authDecision.allowed) {
        return {
          jsonrpc: '2.0',
          id: (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null,
          error: {
            code: McpJsonRpcErrorCode.INVALID_REQUEST,
            message: authDecision.reason ?? 'Unauthorized: MCP authentication failed',
            data: { code: McpErrorCode.POLICY_BLOCKED },
          },
        };
      }
    }

    // 2. Handle Notifications (no response envelope returned)
    if (isMcpNotification(rawMessage)) {
      if (rawMessage.method === 'notifications/initialized') {
        this.clientInitialized = true;
      }
      return null;
    }

    // 3. Handle Requests (must have an id)
    if (!isMcpRequest(rawMessage)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: McpJsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid MCP request: missing or invalid "id" or "method"',
          data: { code: McpErrorCode.INVALID_REQUEST },
        },
      };
    }

    const req: McpRequestEnvelope = rawMessage;

    // Establish request correlation
    const params = req.params ?? {};
    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};

    const projectId =
      (typeof params._projectId === 'string' && params._projectId) ||
      (typeof params.projectId === 'string' && params.projectId) ||
      (typeof args.projectId === 'string' && args.projectId) ||
      null;

    const directorSessionId =
      (typeof params._directorSessionId === 'string' && params._directorSessionId) ||
      (typeof params.directorSessionId === 'string' && params.directorSessionId) ||
      (typeof args.directorSessionId === 'string' && args.directorSessionId) ||
      null;

    const taskId =
      (typeof params._taskId === 'string' && params._taskId) ||
      (typeof params.taskId === 'string' && params.taskId) ||
      (typeof args.taskId === 'string' && args.taskId) ||
      (typeof args.targetTaskId === 'string' && args.targetTaskId) ||
      null;

    const executionIterationId =
      (typeof params._executionIterationId === 'string' && params._executionIterationId) ||
      (typeof params.executionIterationId === 'string' && params.executionIterationId) ||
      (typeof args.executionIterationId === 'string' && args.executionIterationId) ||
      null;

    const correlation = createRequestCorrelation({
      mcpRequestId: req.id,
      directorSessionId,
      projectId,
      taskId,
      executionIterationId,
      customGenerator: this.correlationGenerator,
    });

    // Check server lifecycle readiness
    if (this.state !== McpServerState.RUNNING && this.state !== McpServerState.STARTING) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: McpJsonRpcErrorCode.INTERNAL_ERROR,
          message: `Server is not running (current state: ${this.state})`,
          data: {
            code: McpErrorCode.INTERNAL_FAILURE,
            correlationId: correlation.correlationId,
          },
        },
      };
    }

    // 4. Method Dispatch
    try {
      const result = await this.dispatchMethod(req, correlation);
      return {
        jsonrpc: '2.0',
        id: req.id,
        result,
      };
    } catch (err) {
      const normalized = McpErrorNormalizer.normalize(err, correlation);
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: normalized,
      };
    }
  }

  private async dispatchMethod(
    req: McpRequestEnvelope,
    correlation: McpRequestCorrelation
  ): Promise<unknown> {
    const params = req.params ?? {};

    switch (req.method) {
      case 'initialize': {
        const initResult: McpInitializeResult = {
          protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
          capabilities: this.capabilities,
          serverInfo: {
            name: this.name,
            version: this.version,
          },
          aidmVersion: this.aidmVersion,
          foundationVersion: this.foundationVersion,
          instructions: this.instructions,
        };
        return initResult;
      }

      case 'ping': {
        return {};
      }

      case 'tools/list': {
        return {
          tools: this.getRegisteredTools(),
        };
      }

      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : undefined;
        if (!toolName) {
          throw new McpInvalidRequestError('Missing required parameter "name" in tools/call', {
            correlationId: correlation.correlationId,
          });
        }

        const registration = this.getTool(toolName);
        if (!registration) {
          throw new McpUnsupportedOperationError(`Unsupported tool: "${toolName}"`, {
            toolName,
            correlationId: correlation.correlationId,
          });
        }

        if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null)) {
          throw new McpInvalidRequestError(
            `Invalid arguments for tool "${toolName}": arguments must be an object`,
            { toolName },
            correlation.correlationId
          );
        }

        const args = (typeof params.arguments === 'object' && params.arguments !== null)
          ? (params.arguments as Record<string, unknown>)
          : {};

        // Validate arguments against registration inputSchema
        this.validateToolInputSchema(registration.definition, args, correlation.correlationId);

        // Cross-project check between correlation and arguments (T5)
        if (
          correlation.projectId &&
          args.projectId &&
          typeof args.projectId === 'string' &&
          args.projectId !== correlation.projectId
        ) {
          throw new McpPolicyBlockedError(
            `Cross-project boundary violation: request correlation project '${correlation.projectId}' does not match arguments project '${args.projectId}'`,
            {
              toolName,
              code: 'PROJECT_ISOLATION_VIOLATION',
              reason: 'Cross-project correlation mismatch',
            },
            correlation.correlationId
          );
        }

        // WorkspaceRoot canonical project identity check (T6)
        const resolvedRoot =
          (args.workspaceRoot as string | undefined) ??
          this.delegate?.projectRoot ??
          process.cwd();

        if (args.workspaceRoot && typeof args.workspaceRoot === 'string') {
          const resolvedExplicit = path.resolve(args.workspaceRoot);
          let isDir = false;
          try {
            isDir = fs.existsSync(resolvedExplicit) && fs.statSync(resolvedExplicit).isDirectory();
          } catch {
            isDir = false;
          }

          if (isDir) {
            const callerCanonical = resolveCanonicalProjectIdentity(args.workspaceRoot);
            const isSessionBindingTool =
              toolName === 'aidm.director.session.create' ||
              toolName === 'aidm_director_session_create' ||
              toolName === 'aidm.director.open' ||
              toolName === 'aidm_director_open';

            // 1. Prohibit targeting server repository itself (P18-02 Strict Invariant 1)
            const isCallerServerRepo =
              callerCanonical.projectId === '@aidm/core' ||
              callerCanonical.projectId === 'ai-development-manager-monorepo';
            if (isCallerServerRepo) {
              throw new McpPolicyBlockedError(
                `Target project operations on server repository '${args.workspaceRoot}' are strictly prohibited. Server repository != target project.`,
                {
                  toolName,
                  code: 'PROJECT_ISOLATION_VIOLATION',
                  reason: 'Targeting server repository is prohibited',
                },
                correlation.correlationId
              );
            }

            // 2. Authoritative Project Identity Resolution:
            // Priority A: Active session context (if bound, this is the authoritative target project)
            // Priority B: Configured server projectRoot (if dedicated non-server project)
            const activeRoot = this.delegate?.activeContext?.projectRoot;
            const configuredRoot = this.delegate?.projectRoot;
            const configuredCanonical = configuredRoot ? resolveCanonicalProjectIdentity(configuredRoot) : undefined;
            const isConfiguredServerRepo = configuredCanonical
              ? configuredCanonical.projectId === '@aidm/core' || configuredCanonical.projectId === 'ai-development-manager-monorepo'
              : true;

            const authoritativeRoot = activeRoot ?? (!isConfiguredServerRepo ? configuredRoot : undefined);

            if (authoritativeRoot) {
              const authoritativeCanonical = resolveCanonicalProjectIdentity(authoritativeRoot);

              if (isSessionBindingTool) {
                // In dedicated mode, server cannot be bound or rebound to a conflicting target project
                if (!isConfiguredServerRepo && configuredCanonical && configuredCanonical.projectId !== callerCanonical.projectId) {
                  throw new McpPolicyBlockedError(
                    `Cross-project boundary violation: dedicated server configured for '${configuredCanonical.projectId}' cannot bind to '${callerCanonical.projectId}'`,
                    {
                      toolName,
                      code: 'PROJECT_ISOLATION_VIOLATION',
                      reason: 'Dedicated server project mismatch',
                    },
                    correlation.correlationId
                  );
                }
              } else {
                // All operational tools: caller workspaceRoot MUST match authoritative project identity
                if (authoritativeCanonical.projectId !== callerCanonical.projectId) {
                  throw new McpPolicyBlockedError(
                    `Cross-project boundary violation: caller workspaceRoot '${args.workspaceRoot}' canonical identity '${callerCanonical.projectId}' conflicts with active context projectRoot '${authoritativeCanonical.projectId}'`,
                    {
                      toolName,
                      code: 'PROJECT_ISOLATION_VIOLATION',
                      reason: 'Workspace root canonical identity mismatch',
                    },
                    correlation.correlationId
                  );
                }
              }
            }
          }
        }

        // Policy boundary check if policyEngine is injected
        if (this.policyEngine) {
          const classification = classifyMcpTool(toolName);
          const targetPaths =
            (args.targetFiles as string[] | undefined) ??
            (args.targetPath ? [String(args.targetPath)] : undefined);
          const humanToken = (args.humanApprovalToken ??
            args.token ??
            args.human_approval_token) as string | undefined;

          const policyDecision = this.policyEngine.evaluate({
            command: `mcp tools/call ${toolName}`,
            action_type: classification.actionType,
            actionType: classification.actionType,
            is_read_only: classification.isReadOnly,
            isReadOnly: classification.isReadOnly,
            mutates_source: classification.mutatesSource,
            mutatesSource: classification.mutatesSource,
            requested_risk_level: classification.requestedRiskLevel,
            requestedRiskLevel: classification.requestedRiskLevel,
            project_root: resolvedRoot,
            projectRoot: resolvedRoot,
            target_path: targetPaths,
            targetPath: targetPaths,
            human_approval_token: humanToken,
            humanApprovalToken: humanToken,
            metadata: {
              toolName,
              category: classification.category,
              correlationId: correlation.correlationId,
              projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
              directorSessionId:
                typeof args.directorSessionId === 'string'
                  ? args.directorSessionId
                  : undefined,
            },
          });

          if (!policyDecision.allowed) {
            throw new McpPolicyBlockedError(
              `Tool call "${toolName}" blocked by policy: ${policyDecision.reason}`,
              {
                toolName,
                category: classification.category,
                code: policyDecision.code,
                reason: policyDecision.reason,
                violations: policyDecision.violations,
              },
              correlation.correlationId
            );
          }
        }

        // Execute tool within request context
        const context = {
          correlation,
          delegate: this.delegate,
        };

        const toolResult = await registration.handler(args, context);
        return toolResult;
      }

      default: {
        throw new McpUnsupportedOperationError(`Unsupported MCP method: "${req.method}"`, {
          method: req.method,
          correlationId: correlation.correlationId,
        });
      }
    }
  }
}

export interface AuthoritativeMcpServerOptions {
  readonly transport: McpTransport;
  readonly projectRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly policyEngine?: PolicyEngine;
  readonly name?: string;
  readonly version?: string;
  readonly instructions?: string;
  readonly directorControlPlaneTools?: boolean;
  readonly authToken?: string;
  readonly authMiddleware?: (rawMessage: unknown) => { allowed: boolean; reason?: string };
}

export function createAuthoritativeMcpServer(options: AuthoritativeMcpServerOptions): McpServer {
  const delegate = options.delegate ?? new DefaultMcpOrchestratorDelegate({
    projectRoot: options.projectRoot,
    policyEngine: options.policyEngine,
  });

  return new McpServer({
    name: options.name ?? 'aidm-mcp-server',
    version: options.version ?? '0.1.0',
    transport: options.transport,
    delegate,
    policyEngine: options.policyEngine ?? delegate.policyEngine,
    instructions: options.instructions,
    authToken: options.authToken,
    authMiddleware: options.authMiddleware,
    directorTools: true,
    discoveryTools: true,
    completenessTools: true,
    requirementsScopeTools: true,
    architectureTools: true,
    businessRulesTools: true,
    acceptanceCriteriaTools: true,
    riskTools: true,
    projectSpecTools: true,
    clarificationTools: true,
    approvalTools: true,
    directorSessionTools: true,
    directorDecisionTools: true,
    humanApprovalTools: true,
    executionIntentTools: true,
    executionRequestTools: true,
    executorTools: true,
    evidenceVerifyTools: true,
    phase11ContinuationTools: true,
    taskDecompositionTools: true,
    retryAuthorizeTools: true,
    correctiveTaskTools: true,
    executorContextTools: true,
    recoveryTools: true,
    recoveryEvaluateTools: true,
    directorLoopTools: true,
    driverTools: true,
    directorControlPlaneTools: options.directorControlPlaneTools ?? true,
  });
}

