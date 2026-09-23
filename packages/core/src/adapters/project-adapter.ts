/**
 * ProjectAdapter: Project detection and metadata abstraction.
 *
 * Implements the project-independent adapter contract specified in
 * Technical Discovery Section 22:
 * "ProjectAdapter: Proje türünü tespit eder (Node, Python, Go, Rust, Java vb.)."
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectInfo {
  readonly type: 'node' | 'python' | 'go' | 'rust' | 'unknown';
  readonly name: string;
  readonly version?: string;
  readonly rootDir: string;
  readonly mainEntry?: string;
  readonly testFramework?: string;
  readonly buildTool?: string;
  readonly packageManager?: 'pnpm' | 'npm' | 'yarn' | 'pip' | 'cargo' | 'go';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProjectAdapter {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: readonly string[];

  /**
   * Detects whether the directory matches this project type.
   */
  detect(projectRoot: string): Promise<boolean>;

  /**
   * Extracts typed project metadata.
   */
  getProjectInfo(projectRoot: string): Promise<ProjectInfo>;
}

/**
 * Node / TypeScript project adapter.
 */
export class NodeProjectAdapter implements ProjectAdapter {
  readonly id = 'adapter:project:node';
  readonly name = 'Node.js Project Adapter';
  readonly supportedTypes = ['node'] as const;

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const pkgPath = path.join(projectRoot, 'package.json');
      await fs.promises.access(pkgPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async getProjectInfo(projectRoot: string): Promise<ProjectInfo> {
    const pkgPath = path.join(projectRoot, 'package.json');
    let pkg: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(pkgPath, 'utf-8');
      pkg = JSON.parse(raw);
    } catch {
      // If unparseable or missing, return unknown/minimal
      return {
        type: 'node',
        name: path.basename(projectRoot),
        rootDir: projectRoot,
      };
    }

    const hasTsConfig = await this.fileExists(path.join(projectRoot, 'tsconfig.json'));
    const packageManager = await this.detectPackageManager(projectRoot);

    return {
      type: 'node',
      name: typeof pkg.name === 'string' ? pkg.name : path.basename(projectRoot),
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      rootDir: projectRoot,
      mainEntry: typeof pkg.main === 'string' ? pkg.main : undefined,
      testFramework: 'node:test',
      buildTool: hasTsConfig ? 'tsc' : undefined,
      packageManager,
      metadata: {
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
        scripts: pkg.scripts ?? {},
        type: pkg.type ?? 'commonjs',
      },
    };
  }

  private async detectPackageManager(projectRoot: string): Promise<'pnpm' | 'npm' | 'yarn'> {
    if (await this.fileExists(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await this.fileExists(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
