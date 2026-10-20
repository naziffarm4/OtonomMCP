/**
 * Repo Manifest Scanner (MOD-01)
 *
 * Implements Step 1 of UNIVERSAL-PROJECT-BOOTSTRAP-SPEC.md:
 * Scans the workspace root directory for project manifests across 8 ecosystems + mobile/embedded.
 * Detects whether the repository is INITIALIZED or UNINITIALIZED (empty or contains only stubs/specs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SupportedEcosystem =
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'dotnet'
  | 'php'
  | 'mobile'
  | 'embedded';

export interface WorkspaceStatusResult {
  readonly isInitialized: boolean;
  readonly detectedEcosystems: readonly string[];
  readonly manifestFiles: readonly string[];
  readonly stubFiles?: readonly string[];
}

/**
 * Mapping of exact filenames to their target ecosystem.
 */
const EXACT_MANIFEST_ECOSYSTEM_MAP: Readonly<Record<string, SupportedEcosystem>> = {
  // Node / Web
  'package.json': 'node',
  'tsconfig.json': 'node',

  // Python
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'requirements.txt': 'python',
  'Pipfile': 'python',

  // Go
  'go.mod': 'go',

  // Rust
  'Cargo.toml': 'rust',

  // Java / Kotlin
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',

  // PHP
  'composer.json': 'php',

  // Mobile
  'pubspec.yaml': 'mobile',
  'app.json': 'mobile',

  // Embedded
  'platformio.ini': 'embedded',
};

/**
 * Checks whether an entry matches a supported ecosystem by extension or pattern.
 */
function matchPatternEcosystem(filename: string): SupportedEcosystem | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csproj') || lower.endsWith('.sln')) {
    return 'dotnet';
  }
  return undefined;
}

/**
 * Determines whether a manifest file is merely an empty stub.
 * A stub is defined as:
 * - 0-byte file
 * - whitespace only
 * - JSON containing empty object ({}) or empty array ([])
 * - only comments (#, //, /*) and whitespace
 */
export async function isManifestStub(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) {
      return true;
    }
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return true;
    }

    if (filePath.toLowerCase().endsWith('.json')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          if (Array.isArray(parsed) && parsed.length === 0) {
            return true;
          }
          if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) {
            return true;
          }
        }
      } catch {
        // If not valid JSON, proceed to line checks
      }
    }

    const nonCommentLines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith('#') &&
          !line.startsWith('//') &&
          !line.startsWith('/*') &&
          !line.startsWith('*')
      );

    return nonCommentLines.length === 0;
  } catch {
    return true;
  }
}

/**
 * Scans workspace root for manifest files and reports workspace initialization status.
 */
export async function detectWorkspaceStatus(workspaceRoot: string): Promise<WorkspaceStatusResult> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return {
      isInitialized: false,
      detectedEcosystems: [],
      manifestFiles: [],
    };
  }

  const manifestFiles: string[] = [];
  const stubFiles: string[] = [];
  const ecosystems = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const name = entry.name;
    const exactEcosystem = EXACT_MANIFEST_ECOSYSTEM_MAP[name];
    const patternEcosystem = exactEcosystem ? undefined : matchPatternEcosystem(name);
    const ecosystem = exactEcosystem ?? patternEcosystem;

    if (!ecosystem) {
      continue;
    }

    manifestFiles.push(name);
    ecosystems.add(ecosystem);

    const fullPath = path.join(workspaceRoot, name);
    const stub = await isManifestStub(fullPath);
    if (stub) {
      stubFiles.push(name);
    }
  }

  manifestFiles.sort();
  stubFiles.sort();
  const detectedEcosystems = Array.from(ecosystems).sort();

  // If no manifest files, or if all manifest files are stubs, the workspace is UNINITIALIZED.
  const hasNonStubManifest = manifestFiles.some((f) => !stubFiles.includes(f));
  const isInitialized = manifestFiles.length > 0 && hasNonStubManifest;

  return {
    isInitialized,
    detectedEcosystems,
    manifestFiles,
    ...(stubFiles.length > 0 ? { stubFiles } : {}),
  };
}
