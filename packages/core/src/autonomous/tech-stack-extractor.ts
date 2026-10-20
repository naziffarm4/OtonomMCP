/**
 * Dynamic Tech Stack Extractor (MOD-02)
 *
 * Implements Step 2 & Step 3 of UNIVERSAL-PROJECT-BOOTSTRAP-SPEC.md:
 * Analyzes markdown project specifications and extracts a structured TechnologyStackSchema
 * with non-interactive CLI scaffold commands, confidence score, and framework conventions.
 */

export type SupportedRuntime =
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'dotnet'
  | 'php'
  | 'unknown';

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'kotlin'
  | 'dart'
  | 'unknown';

export type TargetPlatformType = 'web' | 'mobile' | 'backend' | 'desktop' | 'shared';

export interface ArchitectureTarget {
  readonly name: string;
  readonly type: TargetPlatformType;
  readonly framework?: string;
  readonly runtime: SupportedRuntime;
  readonly language: SupportedLanguage;
  readonly path: string;
  readonly scaffoldCommand?: string;
}

export interface TechnologyStackSchema {
  readonly projectName: string;
  readonly isMonorepo: boolean;
  readonly workspaceType: 'standalone' | 'monorepo';
  readonly workspaceManager?: 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'uv';
  readonly targets: readonly ArchitectureTarget[];
  readonly runtime: SupportedRuntime;
  readonly language: SupportedLanguage;
  readonly framework?: string;
  readonly routerOrArchitecture?: string;
  readonly styling?: string;
  readonly uiComponents?: string;
  readonly databaseOrm?: string;
  readonly packageManager?: string;
  readonly scaffoldCommand?: string;
  readonly confidenceScore: number;
}

/**
 * Normalizes text for keyword matching.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[`*_#]/g, ' ');
}

/**
 * Scans markdown text and detects all declared platform / module targets.
 */
export function detectDeclaredTargets(norm: string, projectName: string): ArchitectureTarget[] {
  const targets: ArchitectureTarget[] = [];

  // 1. Web Targets
  if (norm.includes('next.js') || norm.includes('nextjs') || norm.includes('next 14') || norm.includes('next 15')) {
    targets.push({
      name: 'web',
      type: 'web',
      framework: 'nextjs',
      runtime: 'node',
      language: norm.includes('javascript') && !norm.includes('typescript') ? 'javascript' : 'typescript',
      path: 'apps/web',
      scaffoldCommand: 'npx -y create-next-app@latest apps/web --typescript --tailwind --eslint --app --src-dir=false --yes',
    });
  } else if (norm.includes('vite') || norm.includes('react-ts') || (norm.includes('react') && norm.includes('vite'))) {
    targets.push({
      name: 'web',
      type: 'web',
      framework: 'vite-react',
      runtime: 'node',
      language: norm.includes('javascript') && !norm.includes('typescript') ? 'javascript' : 'typescript',
      path: 'apps/web',
      scaffoldCommand: 'npm create vite@latest apps/web -- --template react-ts',
    });
  } else if (norm.includes('nuxt') || norm.includes('vue')) {
    targets.push({
      name: 'web',
      type: 'web',
      framework: 'nuxt',
      runtime: 'node',
      language: 'typescript',
      path: 'apps/web',
      scaffoldCommand: 'npx nuxi@latest init apps/web --packageManager pnpm --gitInit false',
    });
  }

  // 2. Mobile Targets
  if (norm.includes('flutter') || norm.includes('dart')) {
    targets.push({
      name: 'mobile',
      type: 'mobile',
      framework: 'flutter',
      runtime: 'node',
      language: 'dart',
      path: 'apps/mobile',
      scaffoldCommand: `flutter create --org com.example --project-name ${projectName.replace(/-/g, '_')}_mobile apps/mobile`,
    });
  } else if (norm.includes('expo') || (norm.includes('react native') && norm.includes('expo'))) {
    targets.push({
      name: 'mobile',
      type: 'mobile',
      framework: 'expo',
      runtime: 'node',
      language: 'typescript',
      path: 'apps/mobile',
      scaffoldCommand: 'npx -y create-expo-app@latest apps/mobile --template blank-typescript --yes',
    });
  }

  // 3. Backend / API Targets
  if (norm.includes('nestjs') || norm.includes('nest.js')) {
    targets.push({
      name: 'api',
      type: 'backend',
      framework: 'nestjs',
      runtime: 'node',
      language: 'typescript',
      path: 'apps/api',
      scaffoldCommand: 'npx -y @nestjs/cli new apps/api --skip-git --package-manager pnpm',
    });
  } else if (norm.includes('fastapi')) {
    targets.push({
      name: 'api',
      type: 'backend',
      framework: 'fastapi',
      runtime: 'python',
      language: 'python',
      path: 'apps/api',
      scaffoldCommand: 'mkdir -p apps/api && cd apps/api && uv init --app . && uv add fastapi "uvicorn[standard]"',
    });
  }

  // 4. Desktop Targets
  if (norm.includes('tauri')) {
    targets.push({
      name: 'desktop',
      type: 'desktop',
      framework: 'tauri',
      runtime: 'rust',
      language: 'rust',
      path: 'apps/desktop',
    });
  } else if (norm.includes('electron')) {
    targets.push({
      name: 'desktop',
      type: 'desktop',
      framework: 'electron',
      runtime: 'node',
      language: 'typescript',
      path: 'apps/desktop',
    });
  }

  // 5. Shared Libraries / Packages
  if (
    norm.includes('ortak') ||
    norm.includes('shared') ||
    norm.includes('packages/') ||
    norm.includes('ortak kütüphane') ||
    norm.includes('shared package')
  ) {
    if (norm.includes('ui') || norm.includes('component')) {
      targets.push({
        name: 'ui',
        type: 'shared',
        runtime: 'node',
        language: 'typescript',
        path: 'packages/ui',
      });
    }
    if (norm.includes('types') || norm.includes('tip') || norm.includes('schema') || norm.includes('kütüphane')) {
      targets.push({
        name: 'types',
        type: 'shared',
        runtime: 'node',
        language: 'typescript',
        path: 'packages/types',
      });
    }
  }

  return targets;
}

/**
 * Derives a project name slug from markdown text (e.g. # Title) or fallback.
 */
export function deriveProjectSlug(markdown: string, fallbackName = 'app'): string {
  const headingMatch = markdown.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1]) {
    const raw = headingMatch[1].trim();
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug.length > 0) {
      return slug;
    }
  }
  return fallbackName;
}

/**
 * Extracts structured tech stack schema from specification markdown.
 */
export function extractTechStackSchema(markdown: string, overrideProjectName?: string): TechnologyStackSchema {
  const norm = normalize(markdown);
  const projectName = overrideProjectName ?? deriveProjectSlug(markdown, 'app');

  const declaredTargets = detectDeclaredTargets(norm, projectName);
  const isExplicitWorkspace =
    norm.includes('monorepo') ||
    norm.includes('workspace') ||
    norm.includes('turborepo') ||
    norm.includes('pnpm-workspace') ||
    norm.includes('çalışma alanı');

  const isMonorepo = declaredTargets.length > 1 || isExplicitWorkspace;

  let runtime: SupportedRuntime = 'unknown';
  let language: SupportedLanguage = 'unknown';
  let framework: string | undefined;
  let routerOrArchitecture: string | undefined;
  let styling: string | undefined;
  let uiComponents: string | undefined;
  let databaseOrm: string | undefined;
  let packageManager: string | undefined;
  let scaffoldCommand: string | undefined;
  let confidenceScore = 0.5;

  if (isMonorepo) {
    runtime = 'node';
    language = 'typescript';
    const workspaceManager = norm.includes('yarn')
      ? 'yarn'
      : norm.includes('npm') && !norm.includes('pnpm')
        ? 'npm'
        : 'pnpm';
    packageManager = workspaceManager;
    framework = declaredTargets.find((t) => t.type === 'web')?.framework ?? declaredTargets[0]?.framework;
    routerOrArchitecture = norm.includes('pages router') ? 'pages-router' : 'app-router';
    styling = norm.includes('tailwind') ? 'tailwind' : undefined;
    uiComponents = norm.includes('shadcn') ? 'shadcn-ui' : undefined;
    scaffoldCommand = 'pnpm init && pnpm add -Dw turbo typescript @types/node';
    confidenceScore = 0.95;

    // Database / ORM detection
    if (norm.includes('supabase')) {
      databaseOrm = 'supabase';
    } else if (norm.includes('prisma')) {
      databaseOrm = 'prisma';
    } else if (norm.includes('drizzle')) {
      databaseOrm = 'drizzle';
    } else if (norm.includes('sqlalchemy')) {
      databaseOrm = 'sqlalchemy';
    } else if (norm.includes('gorm')) {
      databaseOrm = 'gorm';
    }

    const targets = declaredTargets.length > 0
      ? declaredTargets
      : [{
          name: 'web',
          type: 'web' as TargetPlatformType,
          runtime: 'node' as SupportedRuntime,
          language: 'typescript' as SupportedLanguage,
          path: 'apps/web',
        }];

    return {
      projectName,
      isMonorepo: true,
      workspaceType: 'monorepo',
      workspaceManager,
      targets,
      runtime,
      language,
      ...(framework ? { framework } : {}),
      ...(routerOrArchitecture ? { routerOrArchitecture } : {}),
      ...(styling ? { styling } : {}),
      ...(uiComponents ? { uiComponents } : {}),
      ...(databaseOrm ? { databaseOrm } : {}),
      ...(packageManager ? { packageManager } : {}),
      ...(scaffoldCommand ? { scaffoldCommand } : {}),
      confidenceScore,
    };
  }

  // 1. Framework detection (Standalone mode)
  if (norm.includes('next.js') || norm.includes('nextjs') || norm.includes('next 14') || norm.includes('next 15')) {
    runtime = 'node';
    language = norm.includes('javascript') && !norm.includes('typescript') ? 'javascript' : 'typescript';
    framework = 'nextjs';
    routerOrArchitecture = norm.includes('pages router') ? 'pages-router' : 'app-router';
    styling = norm.includes('tailwind') ? 'tailwind' : undefined;
    uiComponents = norm.includes('shadcn') ? 'shadcn-ui' : undefined;
    packageManager = norm.includes('pnpm') ? 'pnpm' : norm.includes('yarn') ? 'yarn' : 'npm';

    const usePnpmFlag = packageManager === 'pnpm' ? ' --use-pnpm' : packageManager === 'yarn' ? ' --use-yarn' : ' --use-npm';
    scaffoldCommand = `npx -y create-next-app@latest ./ --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*"${usePnpmFlag} --yes`;
    confidenceScore = 0.95;
  } else if (norm.includes('vite') || norm.includes('react-ts') || (norm.includes('react') && norm.includes('vite'))) {
    runtime = 'node';
    language = norm.includes('javascript') && !norm.includes('typescript') ? 'javascript' : 'typescript';
    framework = 'vite-react';
    styling = norm.includes('tailwind') ? 'tailwind' : undefined;
    packageManager = norm.includes('pnpm') ? 'pnpm' : 'npm';
    const template = language === 'typescript' ? 'react-ts' : 'react';
    scaffoldCommand = `npm create vite@latest ./ -- --template ${template}`;
    confidenceScore = 0.95;
  } else if (norm.includes('nestjs') || norm.includes('nest.js')) {
    runtime = 'node';
    language = 'typescript';
    framework = 'nestjs';
    packageManager = norm.includes('pnpm') ? 'pnpm' : 'npm';
    scaffoldCommand = `npx -y @nestjs/cli new ./ --skip-git --package-manager ${packageManager}`;
    confidenceScore = 0.95;
  } else if (norm.includes('fastapi')) {
    runtime = 'python';
    language = 'python';
    framework = 'fastapi';
    packageManager = norm.includes('uv') ? 'uv' : 'poetry';
    if (packageManager === 'uv') {
      scaffoldCommand = 'uv init --app . && uv add fastapi "uvicorn[standard]"';
    } else {
      scaffoldCommand = 'poetry init -n && poetry add fastapi "uvicorn[standard]"';
    }
    confidenceScore = 0.95;
  } else if (norm.includes('flutter') || norm.includes('dart')) {
    runtime = 'node'; // ecosystem classification for cross-platform
    language = 'dart';
    framework = 'flutter';
    packageManager = 'pub';
    scaffoldCommand = `flutter create --org com.example --project-name ${projectName.replace(/-/g, '_')} --platforms android,ios,web .`;
    confidenceScore = 0.95;
  } else if (norm.includes('expo') || (norm.includes('react native') && norm.includes('expo'))) {
    runtime = 'node';
    language = 'typescript';
    framework = 'expo';
    packageManager = norm.includes('pnpm') ? 'pnpm' : 'npm';
    scaffoldCommand = 'npx -y create-expo-app@latest . --template blank-typescript --yes';
    confidenceScore = 0.95;
  } else if (norm.includes('platformio') || norm.includes('esp32')) {
    runtime = 'unknown';
    language = 'unknown';
    framework = 'platformio';
    scaffoldCommand = 'pio project init --board esp32dev';
    confidenceScore = 0.9;
  } else if (norm.includes('cargo') || norm.includes('rust')) {
    runtime = 'rust';
    language = 'rust';
    framework = norm.includes('actix') ? 'actix-web' : norm.includes('axum') ? 'axum' : undefined;
    packageManager = 'cargo';
    scaffoldCommand = 'cargo init --vcs none .';
    confidenceScore = 0.95;
  } else if (norm.includes('golang') || norm.includes('go mod') || norm.includes('go 1.')) {
    runtime = 'go';
    language = 'go';
    framework = norm.includes('gin') ? 'gin' : norm.includes('fiber') ? 'fiber' : undefined;
    packageManager = 'go-modules';
    scaffoldCommand = `go mod init ${projectName}`;
    confidenceScore = 0.95;
  } else {
    // Fallback heuristic based on generic language cues
    if (norm.includes('python')) {
      runtime = 'python';
      language = 'python';
      packageManager = 'pip';
      scaffoldCommand = 'python -m venv .venv';
      confidenceScore = 0.7;
    } else if (norm.includes('typescript') || norm.includes('node') || norm.includes('javascript')) {
      runtime = 'node';
      language = norm.includes('javascript') ? 'javascript' : 'typescript';
      packageManager = 'pnpm';
      scaffoldCommand = 'pnpm init';
      confidenceScore = 0.7;
    }
  }

  // Database / ORM detection
  if (norm.includes('supabase')) {
    databaseOrm = 'supabase';
  } else if (norm.includes('prisma')) {
    databaseOrm = 'prisma';
  } else if (norm.includes('drizzle')) {
    databaseOrm = 'drizzle';
  } else if (norm.includes('sqlalchemy')) {
    databaseOrm = 'sqlalchemy';
  } else if (norm.includes('gorm')) {
    databaseOrm = 'gorm';
  }

  // Router / Architecture detection if not yet determined
  if (!routerOrArchitecture) {
    if (norm.includes('clean architecture')) {
      routerOrArchitecture = 'clean-architecture';
    } else if (norm.includes('mvc')) {
      routerOrArchitecture = 'mvc';
    }
  }

  // Styling if not yet determined
  if (!styling && norm.includes('tailwind')) {
    styling = 'tailwind';
  }

  // UI Components if not yet determined
  if (!uiComponents && norm.includes('shadcn')) {
    uiComponents = 'shadcn-ui';
  }

  const standaloneTargets = declaredTargets.length > 0
    ? declaredTargets.map((t) => ({ ...t, path: './' }))
    : framework
      ? [{
          name: projectName,
          type: 'web' as TargetPlatformType,
          framework,
          runtime,
          language,
          path: './',
          scaffoldCommand,
        }]
      : [];

  return {
    projectName,
    isMonorepo: false,
    workspaceType: 'standalone',
    targets: standaloneTargets,
    runtime,
    language,
    ...(framework ? { framework } : {}),
    ...(routerOrArchitecture ? { routerOrArchitecture } : {}),
    ...(styling ? { styling } : {}),
    ...(uiComponents ? { uiComponents } : {}),
    ...(databaseOrm ? { databaseOrm } : {}),
    ...(packageManager ? { packageManager } : {}),
    ...(scaffoldCommand ? { scaffoldCommand } : {}),
    confidenceScore,
  };
}

/**
 * Returns standard non-interactive health verification commands for a given technology stack (Section 7).
 */
export function getHealthVerificationCommands(schema: TechnologyStackSchema): readonly string[] {
  const cmds: string[] = [];

  switch (schema.runtime) {
    case 'node':
      if (schema.language === 'typescript') {
        cmds.push('npx tsc --noEmit');
      }
      if (schema.packageManager === 'pnpm') {
        cmds.push('pnpm build');
      } else {
        cmds.push('npm run build');
      }
      break;
    case 'python':
      if (schema.packageManager === 'poetry') {
        cmds.push('poetry run mypy .', 'poetry run ruff check .');
      } else if (schema.packageManager === 'uv') {
        cmds.push('uv run mypy .', 'uv run ruff check .');
      } else {
        cmds.push('python -m py_compile $(git ls-files "*.py")');
      }
      break;
    case 'go':
      cmds.push('go vet ./...', 'go build -o /dev/null ./...');
      break;
    case 'rust':
      cmds.push('cargo check', 'cargo clippy', 'cargo build');
      break;
    case 'unknown':
    default:
      if (schema.framework === 'flutter') {
        cmds.push('flutter analyze', 'flutter test');
      } else if (schema.framework === 'platformio') {
        cmds.push('pio check', 'pio run');
      }
      break;
  }

  return Object.freeze(cmds);
}

