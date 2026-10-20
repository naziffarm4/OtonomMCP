/**
 * Unit tests: Universal Health Gate & Directive Injection (MOD-04, MOD-06)
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getHealthVerificationCommands,
  extractTechStackSchema,
} from '../dist/autonomous/index.js';
import { DirectorPromptBuilder } from '../dist/director/index.js';

describe('Universal Health Gate & Directive Injection (MOD-04, MOD-06)', () => {
  it('generates correct health check commands for Node / TypeScript projects', () => {
    const schema = extractTechStackSchema('# Next App\nNext.js with TypeScript and pnpm');
    const cmds = getHealthVerificationCommands(schema);
    assert.ok(cmds.includes('npx tsc --noEmit'));
    assert.ok(cmds.includes('pnpm build'));
  });

  it('generates correct health check commands for Python projects with Poetry', () => {
    const schema = extractTechStackSchema('# API\nFastAPI with Poetry');
    const cmds = getHealthVerificationCommands(schema);
    assert.ok(cmds.includes('poetry run mypy .'));
    assert.ok(cmds.includes('poetry run ruff check .'));
  });

  it('generates correct health check commands for Go projects', () => {
    const schema = extractTechStackSchema('# Worker\nGo 1.22 gin');
    const cmds = getHealthVerificationCommands(schema);
    assert.ok(cmds.includes('go vet ./...'));
    assert.ok(cmds.includes('go build -o /dev/null ./...'));
  });

  it('generates correct health check commands for Rust projects', () => {
    const schema = extractTechStackSchema('# Tool\nRust and cargo');
    const cmds = getHealthVerificationCommands(schema);
    assert.ok(cmds.includes('cargo check'));
    assert.ok(cmds.includes('cargo clippy'));
    assert.ok(cmds.includes('cargo build'));
  });

  it('injects Section 10 Zero-Monolith Directive into Director system prompt', () => {
    const builder = new DirectorPromptBuilder();
    const systemPrompt = builder.buildSystemPrompt();
    assert.ok(systemPrompt.includes('SECTION 10: ZERO-MONOLITH DIRECTIVE'));
    assert.ok(systemPrompt.includes('DO NOT dump implementation code into a single arbitrary file'));
    assert.ok(systemPrompt.includes('Execute the official non-interactive CLI to scaffold the full project skeleton'));
  });
});
