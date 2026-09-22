/**
 * Authoritative Actor Definitions for AI Development Manager.
 * 
 * Strict Hierarchy (Non-negotiable):
 * USER / PRODUCT OWNER
 *         ↓
 * PROJECT DIRECTOR / CHATGPT
 *         ↓
 * ORCHESTRATOR
 *         ↓
 * ANTIGRAVITY / EXECUTOR
 */

export const Actor = {
  USER: 'USER',
  DIRECTOR: 'DIRECTOR',
  ORCHESTRATOR: 'ORCHESTRATOR',
  EXECUTOR: 'EXECUTOR',
} as const;

export type Actor = (typeof Actor)[keyof typeof Actor];

export const ACTORS = Object.values(Actor) as readonly Actor[];

export const USER = Actor.USER;
export const DIRECTOR = Actor.DIRECTOR;
export const ORCHESTRATOR = Actor.ORCHESTRATOR;
export const EXECUTOR = Actor.EXECUTOR;

export function isActor(value: unknown): value is Actor {
  return typeof value === 'string' && (ACTORS as readonly string[]).includes(value);
}
