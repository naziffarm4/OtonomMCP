/**
 * Unit tests: `aidm run --spec` argument parsing & exit-code mapping
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { parseCliTokens, parseRunSpecArgs, exitCodeForAutonomousStatus, CliExitCode, getHelpText } from '../dist/cli/index.js';

const ctx = { projectRoot: '/proj', cwd: '/work', json: false, verbose: false };
const parse = (argv: string[]) => parseRunSpecArgs(parseCliTokens(argv).flags, ctx);

describe('aidm run --spec argument parsing', () => {
  it('parses spec, budget, dry-run and resolves spec relative to cwd', () => {
    const r = parse(['run', '--spec', 'proje.md', '--budget-usd', '5', '--dry-run']);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.options.specPath, path.resolve('/work', 'proje.md'));
    assert.equal(r.options.budgetUsd, 5);
    assert.equal(r.options.dryRun, true);
    assert.equal(r.options.commit, true);
  });

  it('supports --flag=value, --no-commit, --max-cycles, --mandate-hours and provider overrides', () => {
    const r = parse(['run', '--spec=docs/a.md', '--budget-usd=0.5', '--no-commit', '--max-cycles', '4', '--mandate-hours', '2', '--llm-model', 'grok-4', '--llm-endpoint', 'https://api.x.ai/v1/chat/completions']);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.options.budgetUsd, 0.5);
    assert.equal(r.options.commit, false);
    assert.equal(r.options.maxCyclesPerTask, 4);
    assert.equal(r.options.mandateValidityHours, 2);
    assert.equal(r.options.llmModel, 'grok-4');
    assert.equal(r.options.llmEndpoint, 'https://api.x.ai/v1/chat/completions');
  });

  it('rejects missing/invalid values', () => {
    const bad = [
      ['run', '--spec'],
      ['run', '--spec', 'notes.txt'],
      ['run', '--spec', 'a.md', '--budget-usd', '0'],
      ['run', '--spec', 'a.md', '--budget-usd', '-3'],
      ['run', '--spec', 'a.md', '--budget-usd', 'abc'],
      ['run', '--spec', 'a.md', '--budget-usd'],
      ['run', '--spec', 'a.md', '--max-cycles', '2.5'],
      ['run', '--spec', 'a.md', '--max-cycles', '99'],
      ['run', '--spec', 'a.md', '--mandate-hours', '48'],
    ];
    for (const argv of bad) assert.equal(parse(argv).ok, false, argv.join(' '));
  });

  it('maps run statuses to CLI exit codes (human-gated statuses are HUMAN_BLOCKED)', () => {
    assert.equal(exitCodeForAutonomousStatus('COMPLETED'), CliExitCode.SUCCESS);
    assert.equal(exitCodeForAutonomousStatus('DRY_RUN_OK'), CliExitCode.SUCCESS);
    assert.equal(exitCodeForAutonomousStatus('BLOCKED_ON_AUTH_CONTEXT'), CliExitCode.HUMAN_BLOCKED);
    assert.equal(exitCodeForAutonomousStatus('BLOCKED_ON_HUMAN'), CliExitCode.HUMAN_BLOCKED);
    assert.equal(exitCodeForAutonomousStatus('BUDGET_EXHAUSTED'), CliExitCode.HUMAN_BLOCKED);
    assert.equal(exitCodeForAutonomousStatus('CONFIGURATION_ERROR'), CliExitCode.USAGE_ERROR);
    assert.equal(exitCodeForAutonomousStatus('PARTIAL'), CliExitCode.PROJECT_FAILED);
  });

  it('help text documents run --spec', () => {
    assert.match(getHelpText(), /run --spec <file\.md>/);
  });
});
