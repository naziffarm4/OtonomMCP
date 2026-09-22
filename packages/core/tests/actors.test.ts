import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Actor,
  ACTORS,
  USER,
  DIRECTOR,
  ORCHESTRATOR,
  EXECUTOR,
  isActor,
} from '../dist/actors.js';

describe('Actor Definitions and Hierarchy', () => {
  it('should define all four required actors in Actor enum/object', () => {
    assert.equal(Actor.USER, 'USER');
    assert.equal(Actor.DIRECTOR, 'DIRECTOR');
    assert.equal(Actor.ORCHESTRATOR, 'ORCHESTRATOR');
    assert.equal(Actor.EXECUTOR, 'EXECUTOR');
  });

  it('should export standalone actor constants matching Actor values', () => {
    assert.equal(USER, 'USER');
    assert.equal(DIRECTOR, 'DIRECTOR');
    assert.equal(ORCHESTRATOR, 'ORCHESTRATOR');
    assert.equal(EXECUTOR, 'EXECUTOR');
  });

  it('should list all actors in ACTORS array', () => {
    assert.deepEqual([...ACTORS], ['USER', 'DIRECTOR', 'ORCHESTRATOR', 'EXECUTOR']);
  });

  it('should correctly validate actors with isActor guard', () => {
    assert.equal(isActor('USER'), true);
    assert.equal(isActor('DIRECTOR'), true);
    assert.equal(isActor('ORCHESTRATOR'), true);
    assert.equal(isActor('EXECUTOR'), true);

    assert.equal(isActor('UNKNOWN'), false);
    assert.equal(isActor(''), false);
    assert.equal(isActor(null), false);
    assert.equal(isActor(123), false);
    assert.equal(isActor({}), false);
  });
});
