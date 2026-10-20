/**
 * Architecture Intent Report & Anti-Simplification Enforcement (MOD-03)
 *
 * Implements the Absolute Fidelity Law (Zero Unilateral Simplification) and
 * records structured architectural topology under .ai-manager/reports/architecture-intent.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TechnologyStackSchema, ArchitectureTarget } from './tech-stack-extractor.js';

export const ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE = `[DIRECTIVE: ZERO_UNILATERAL_SIMPLIFICATION]
1. The specification is the absolute, inviolable contract.
2. You are strictly forbidden from:
   - Downgrading multi-platform or workspace requirements into a single monolithic project.
   - Postponing or dropping declared architectural layers (e.g. monorepo, desktop, mobile, backend) on your own initiative.
   - Making arbitrary "Phase 1 only" scope reduction assumptions unless the user explicitly requested it in the prompt.
3. If the specification describes a comprehensive architecture, your planning, scaffolding (TASK-000), and task breakdown MUST reflect that full architecture from day one.
4. If you identify architectural complexity, ambiguities, or trade-offs, DO NOT quietly truncate scope. You MUST formulate a structured Architectural Report and consult Antigravity / User.`;

export const ARCHITECTURE_INTENT_FILE = path.join('.ai-manager', 'reports', 'architecture-intent.json');

export interface ArchitectureIntentReport {
  readonly projectId: string;
  readonly projectName: string;
  readonly specFingerprint: string;
  readonly generatedAt: string;
  readonly isMonorepo: boolean;
  readonly workspaceType: 'standalone' | 'monorepo';
  readonly workspaceManager?: string;
  readonly targets: readonly ArchitectureTarget[];
  readonly rootDirectories: readonly string[];
  readonly packageHierarchy: readonly {
    readonly name: string;
    readonly type: string;
    readonly path: string;
    readonly framework?: string;
  }[];
  readonly antiSimplificationDirective: string;
}

export interface GenerateArchitectureIntentOptions {
  readonly projectId: string;
  readonly projectName: string;
  readonly specFingerprint: string;
  readonly techStack: TechnologyStackSchema;
  readonly generatedAt?: string;
}

/**
 * Derives root directory candidates based on targets and workspace setup.
 */
function deriveRootDirectories(techStack: TechnologyStackSchema): string[] {
  if (!techStack.isMonorepo) {
    return ['src', 'public', 'tests'];
  }
  const dirs = new Set<string>(['apps', 'packages']);
  for (const t of techStack.targets) {
    const rootPart = t.path.split('/')[0];
    if (rootPart && rootPart !== '.') {
      dirs.add(rootPart);
    }
  }
  return [...dirs];
}

/**
 * Generates structured ArchitectureIntentReport from tech stack and spec metadata.
 */
export function generateArchitectureIntentReport(options: GenerateArchitectureIntentOptions): ArchitectureIntentReport {
  const { projectId, projectName, specFingerprint, techStack } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const packageHierarchy = techStack.targets.map((t) => ({
    name: t.name,
    type: t.type,
    path: t.path,
    ...(t.framework ? { framework: t.framework } : {}),
  }));

  const rootDirectories = deriveRootDirectories(techStack);

  return {
    projectId,
    projectName,
    specFingerprint,
    generatedAt,
    isMonorepo: techStack.isMonorepo,
    workspaceType: techStack.workspaceType,
    ...(techStack.workspaceManager ? { workspaceManager: techStack.workspaceManager } : {}),
    targets: techStack.targets,
    rootDirectories,
    packageHierarchy,
    antiSimplificationDirective: ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE,
  };
}

/**
 * Persists ArchitectureIntentReport atomically to .ai-manager/reports/architecture-intent.json.
 */
export function saveArchitectureIntentReport(projectRoot: string, report: ArchitectureIntentReport): void {
  const targetPath = path.join(projectRoot, ARCHITECTURE_INTENT_FILE);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Reads ArchitectureIntentReport from .ai-manager/reports/architecture-intent.json if present.
 */
export function readArchitectureIntentReport(projectRoot: string): ArchitectureIntentReport | null {
  const targetPath = path.join(projectRoot, ARCHITECTURE_INTENT_FILE);
  try {
    const content = fs.readFileSync(targetPath, 'utf8');
    return JSON.parse(content) as ArchitectureIntentReport;
  } catch {
    return null;
  }
}
