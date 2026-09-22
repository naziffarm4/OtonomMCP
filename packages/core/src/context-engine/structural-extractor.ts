import * as path from 'node:path';
import type { L1StructuralItem } from './context-types.js';

export interface ExtractedL1Data {
  interfaces: string[];
  typeDefinitions: string[];
  signatures: string[];
  imports: string[];
  exports: string[];
  structuralItems: L1StructuralItem[];
  summary: string;
}

/**
 * Deterministically extracts L1 structural information (interfaces, types, signatures, imports/exports)
 * from file content without loading full function/method implementations.
 */
export function extractL1Structure(
  content: string,
  filePath: string,
  options?: { relevantSymbols?: string[]; diffChunk?: string }
): ExtractedL1Data {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    return extractCodeStructure(content, filePath, options?.relevantSymbols);
  }

  if (ext === '.json') {
    return extractJsonStructure(content, filePath);
  }

  if (ext === '.md') {
    return extractMarkdownStructure(content, filePath);
  }

  return extractGenericTextStructure(content, filePath);
}

function extractCodeStructure(
  content: string,
  filePath: string,
  relevantSymbols?: string[]
): ExtractedL1Data {
  const lines = content.split('\n');
  const interfaces: string[] = [];
  const typeDefinitions: string[] = [];
  const signatures: string[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const structuralItems: L1StructuralItem[] = [];

  const symbolFilterSet = relevantSymbols && relevantSymbols.length > 0
    ? new Set(relevantSymbols)
    : null;

  let inInterface = false;
  let currentInterfaceLines: string[] = [];
  let currentInterfaceName = '';
  let interfaceStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Multiline interface capture
    if (inInterface) {
      currentInterfaceLines.push(line);
      if (trimmed.startsWith('}')) {
        inInterface = false;
        const fullDef = currentInterfaceLines.join('\n');
        interfaces.push(fullDef);
        structuralItems.push({
          name: currentInterfaceName,
          kind: 'interface',
          signature: fullDef,
          lineStart: interfaceStartLine,
          lineEnd: lineNum,
        });
      }
      continue;
    }

    // Imports
    if (trimmed.startsWith('import ') || trimmed.startsWith('import type ')) {
      imports.push(trimmed);
      structuralItems.push({
        name: 'import',
        kind: 'import',
        signature: trimmed,
        lineStart: lineNum,
        lineEnd: lineNum,
      });
      continue;
    }

    // Exports
    if (trimmed.startsWith('export ') && !trimmed.startsWith('export interface ') && !trimmed.startsWith('export type ')) {
      exports.push(trimmed);
    }

    // Interface start
    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
    if (interfaceMatch) {
      currentInterfaceName = interfaceMatch[1];
      if (!symbolFilterSet || symbolFilterSet.has(currentInterfaceName)) {
        if (trimmed.endsWith('{')) {
          inInterface = true;
          currentInterfaceLines = [line];
          interfaceStartLine = lineNum;
        } else {
          interfaces.push(trimmed);
          structuralItems.push({
            name: currentInterfaceName,
            kind: 'interface',
            signature: trimmed,
            lineStart: lineNum,
            lineEnd: lineNum,
          });
        }
      }
      continue;
    }

    // Type alias
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
    if (typeMatch) {
      const typeName = typeMatch[1];
      if (!symbolFilterSet || symbolFilterSet.has(typeName)) {
        typeDefinitions.push(trimmed);
        structuralItems.push({
          name: typeName,
          kind: 'type',
          signature: trimmed,
          lineStart: lineNum,
          lineEnd: lineNum,
        });
      }
      continue;
    }

    // Function signature
    const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const funcName = funcMatch[1];
      if (!symbolFilterSet || symbolFilterSet.has(funcName)) {
        const sig = trimmed.endsWith('{') ? trimmed.slice(0, -1).trim() : trimmed;
        signatures.push(sig);
        structuralItems.push({
          name: funcName,
          kind: 'function',
          signature: sig,
          lineStart: lineNum,
          lineEnd: lineNum,
        });
      }
      continue;
    }

    // Class signature
    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
    if (classMatch) {
      const className = classMatch[1];
      if (!symbolFilterSet || symbolFilterSet.has(className)) {
        const sig = trimmed.endsWith('{') ? trimmed.slice(0, -1).trim() : trimmed;
        signatures.push(sig);
        structuralItems.push({
          name: className,
          kind: 'class',
          signature: sig,
          lineStart: lineNum,
          lineEnd: lineNum,
        });
      }
      continue;
    }
  }

  // Sort structural items deterministically by line number
  structuralItems.sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0));

  const summaryParts = [
    `// [L1 Structural Context] ${filePath}`,
    `// Imports (${imports.length}):`,
    ...imports.slice(0, 10).map((imp) => `//   ${imp}`),
    `// Interfaces (${interfaces.length}) & Types (${typeDefinitions.length}):`,
    ...interfaces.map((i) => i.split('\n')[0]),
    ...typeDefinitions,
    `// Signatures (${signatures.length}):`,
    ...signatures,
    `// Exports (${exports.length}):`,
    ...exports.slice(0, 10).map((exp) => `//   ${exp}`),
  ];

  return {
    interfaces,
    typeDefinitions,
    signatures,
    imports,
    exports,
    structuralItems,
    summary: summaryParts.join('\n'),
  };
}

function extractJsonStructure(content: string, filePath: string): ExtractedL1Data {
  try {
    const parsed = JSON.parse(content);
    const keys = Object.keys(parsed);
    const summary = `// [L1 JSON Structure] ${filePath}\n// Keys: ${keys.join(', ')}`;
    const structuralItems: L1StructuralItem[] = keys.map((key) => ({
      name: key,
      kind: 'section',
      signature: `"${key}": ${typeof (parsed as Record<string, unknown>)[key]}`,
    }));

    return {
      interfaces: [],
      typeDefinitions: [],
      signatures: [],
      imports: [],
      exports: keys,
      structuralItems,
      summary,
    };
  } catch {
    return extractGenericTextStructure(content, filePath);
  }
}

function extractMarkdownStructure(content: string, filePath: string): ExtractedL1Data {
  const lines = content.split('\n');
  const headings: string[] = [];
  const structuralItems: L1StructuralItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) {
      headings.push(trimmed);
      structuralItems.push({
        name: trimmed,
        kind: 'section',
        signature: trimmed,
        lineStart: i + 1,
        lineEnd: i + 1,
      });
    }
  }

  const summary = `// [L1 Markdown Outline] ${filePath}\n${headings.join('\n')}`;

  return {
    interfaces: [],
    typeDefinitions: [],
    signatures: headings,
    imports: [],
    exports: [],
    structuralItems,
    summary,
  };
}

function extractGenericTextStructure(content: string, filePath: string): ExtractedL1Data {
  const lines = content.split('\n');
  const summary = `// [L1 Generic Text Structure] ${filePath} (${lines.length} lines, ${content.length} bytes)`;
  return {
    interfaces: [],
    typeDefinitions: [],
    signatures: [],
    imports: [],
    exports: [],
    structuralItems: [
      {
        name: path.basename(filePath),
        kind: 'section',
        signature: `${lines.length} lines`,
      },
    ],
    summary,
  };
}
