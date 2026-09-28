/**
 * Adaptive Discovery Normalizer & Semantic Extractor (Phase 15 TASK-P15-01)
 *
 * Deterministically parses natural language intent, extracts structured discovery
 * information across all discovery areas, deduplicates items, and computes canonical IDs.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly deterministic: no Math.random(), no current timestamps in fingerprints or IDs.
 * 2. Deduplicates incoming functional requirements and business rules.
 * 3. Extracts domain entities without requiring external LLM transport in P15-01.
 */

import * as crypto from 'node:crypto';
import type {
  DiscoverySections,
  FunctionalRequirementItem,
  DiscoveryRisk,
  HumanDecisionPoint,
  DiscoveryQuestion,
  QuestionClassification,
} from './adaptive-discovery-types.js';

/**
 * Computes deterministic SHA-256 hash of a normalized string.
 */
export function computeDeterministicHash(input: string, length = 12): string {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, length);
}

/**
 * Computes deterministic canonical ID for a requirement.
 */
export function createDeterministicRequirementId(title: string, description: string): string {
  const hash = computeDeterministicHash(`${title}:::${description}`);
  return `FREQ-${hash}`;
}

/**
 * Computes deterministic canonical ID for a human decision.
 */
export function createDeterministicDecisionId(title: string, alternatives: readonly string[]): string {
  const sortedAlts = [...alternatives].sort().join(',');
  const hash = computeDeterministicHash(`${title}:::${sortedAlts}`);
  return `HDEC-${hash}`;
}

/**
 * Computes deterministic canonical ID for a question.
 */
export function createDeterministicQuestionId(
  category: string,
  question: string,
  dependentSection: string
): string {
  const hash = computeDeterministicHash(`${category}:::${question}:::${dependentSection}`);
  const catPrefix = category.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `Q-${catPrefix}-${hash}`;
}

/**
 * Computes deterministic canonical ID for a risk.
 */
export function createDeterministicRiskId(category: string, statement: string): string {
  const hash = computeDeterministicHash(`${category}:::${statement}`);
  return `RISK-${category.toUpperCase()}-${hash}`;
}

/**
 * Recursively canonicalizes a payload into a deterministic JSON string with sorted keys.
 */
export function canonicalizeForFingerprint(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return JSON.stringify(val);
  }
  if (typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalizeForFingerprint(item)).join(',') + ']';
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const entries = sortedKeys.map(
      (k) => `${JSON.stringify(k)}:${canonicalizeForFingerprint(obj[k])}`
    );
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Computes a deterministic SHA-256 fingerprint for arbitrary structured payload.
 */
export function computeDeterministicFingerprint(payload: unknown): string {
  const canonical = canonicalizeForFingerprint(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Deduplicates string array deterministically while preserving case of first occurrence.
 */
export function deduplicateStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Deduplicates functional requirement items deterministically by normalized title/description.
 */
export function deduplicateRequirements(
  items: readonly FunctionalRequirementItem[]
): FunctionalRequirementItem[] {
  const seen = new Set<string>();
  const result: FunctionalRequirementItem[] = [];

  for (const req of items) {
    const key = `${req.title.trim().toLowerCase()}:::${req.description.trim().toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({
        ...req,
        id: req.id || createDeterministicRequirementId(req.title, req.description),
        title: req.title.trim(),
        description: req.description.trim(),
        businessRules: deduplicateStrings(req.businessRules ?? []),
      });
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Natural language intent parser and extractor for adaptive project discovery.
 * Transforms free-form project requests into structured discovery fields.
 */
export function extractStructuredDiscoveryFromIntent(
  rawPrompt: string,
  fallbackName = 'unnamed-project'
): {
  projectIdentity: { name: string; purpose: string; desiredOutcome: string };
  productScope: {
    inScope: string[];
    outOfScope: string[];
    targetUsers: string[];
    primaryWorkflows: string[];
  };
  capabilities: FunctionalRequirementItem[];
  behaviors: string[];
  businessRules: string[];
  nonFunctional: {
    performance: string[];
    security: string[];
    reliability: string[];
    scalability: string[];
    availability: string[];
    usability: string[];
    compatibility: string[];
  };
  technology: {
    requiredTechnologies: string[];
    preferredTechnologies: string[];
    prohibitedTechnologies: string[];
    platformConstraints: string[];
  };
  architecture: {
    architecturalConstraints: string[];
    integrationRequirements: string[];
    deploymentModel?: string;
    dataStorageExpectations: string[];
  };
  acceptance: {
    expectedBehavior: string[];
    measurableCriteria: string[];
    definitionOfCompletion: string[];
  };
  risks: {
    technicalRisks: DiscoveryRisk[];
    productRisks: DiscoveryRisk[];
    operationalRisks: DiscoveryRisk[];
    dependencies: string[];
  };
} {
  const text = rawPrompt.trim();
  const lower = text.toLowerCase();

  // 1. Identity & Name Inference
  let name = fallbackName;
  const nameMatch = text.match(
    /(?:build|create|develop|make)\s+(?:a|an)?\s*([a-zA-Z0-9_\-\s]{3,35}?)(?:\s+(?:with|that|for|using|app|system|game|service|platform)|\.|\,|$)/i
  );
  if (nameMatch && nameMatch[1]) {
    const candidate = nameMatch[1].trim().replace(/\s+/g, '-').toLowerCase();
    if (candidate.length >= 3 && !['project', 'application', 'system', 'app'].includes(candidate)) {
      name = candidate;
    }
  }

  const purpose = text.length > 0 ? text : 'Initial project discovery request.';
  const desiredOutcome = `Functional, tested, production-ready ${name} fulfilling product requirements.`;

  // 2. Scope & Target Users
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  const targetUsers: string[] = [];
  const primaryWorkflows: string[] = [];

  // Detect explicit exclusions
  const exclusionMatches = text.match(/(?:not in scope|out of scope|exclude|no\s+[a-z]+|without\s+[a-z]+)[^.]*/gi) ?? [];
  for (const match of exclusionMatches) {
    outOfScope.push(match.trim());
  }

  // Detect platforms
  const platformConstraints: string[] = [];
  if (lower.includes('mobile')) {
    platformConstraints.push('Mobile (iOS/Android responsive or native)');
    inScope.push('Mobile device support');
  }
  if (lower.includes('web') || lower.includes('browser')) {
    platformConstraints.push('Web / Browser');
    inScope.push('Web application interface');
  }
  if (lower.includes('desktop')) {
    platformConstraints.push('Desktop');
    inScope.push('Desktop application support');
  }
  if (lower.includes('cli') || lower.includes('command line')) {
    platformConstraints.push('CLI / Terminal');
    inScope.push('Command line interface');
  }

  // Detect users & players
  if (lower.includes('player')) {
    const playerMatch = text.match(/(\d+)[-\s]*player/i);
    const playerCount = playerMatch ? playerMatch[1] : 'multi';
    targetUsers.push(`${playerCount}-player game participants`);
    inScope.push(`${playerCount}-player gameplay session`);
  } else if (lower.includes('user') || lower.includes('customer')) {
    targetUsers.push('End users and authenticated accounts');
  } else {
    targetUsers.push('End users');
  }

  // 3. Functional Requirements & Capabilities
  const capabilities: FunctionalRequirementItem[] = [];
  const behaviors: string[] = [];
  const businessRules: string[] = [];

  // Feature detection patterns
  if (lower.includes('account') || lower.includes('auth') || lower.includes('login') || lower.includes('user management')) {
    capabilities.push({
      id: createDeterministicRequirementId('Account Management', 'User authentication, profile management, and session credentials.'),
      title: 'Account Management',
      description: 'User registration, authentication, profile management, and credential sessions.',
      behavior: 'Users can register, log in, manage their profile, and securely authenticate.',
      businessRules: ['User identities must be unique', 'Sessions must be verified'],
      source: 'PRODUCT_OWNER_DISCOVERY',
    });
    primaryWorkflows.push('User Registration and Authentication');
  }

  if (lower.includes('room') || lower.includes('lobby') || lower.includes('matchmaking')) {
    capabilities.push({
      id: createDeterministicRequirementId('Room & Lobby Management', 'Creating, joining, listing, and managing game rooms and sessions.'),
      title: 'Room & Lobby Management',
      description: 'Creating, joining, listing, and managing game rooms and sessions.',
      behavior: 'Players can create rooms, browse available rooms, and join open seats.',
      businessRules: ['Room capacity limits must be enforced', 'Only authorized players may join private rooms'],
      source: 'PRODUCT_OWNER_DISCOVERY',
    });
    primaryWorkflows.push('Room Creation and Matchmaking');
  }

  if (lower.includes('score') || lower.includes('scoring') || lower.includes('leaderboard')) {
    capabilities.push({
      id: createDeterministicRequirementId('Scoring System', 'Tracking, computing, and persisting game scores and match outcomes.'),
      title: 'Scoring System',
      description: 'Tracking, computing, and persisting game scores and match outcomes.',
      behavior: 'Game events trigger score updates according to domain rules, persisting outcome at match conclusion.',
      businessRules: ['Score computation must be tamper-proof and server-authoritative'],
      source: 'PRODUCT_OWNER_DISCOVERY',
    });
    primaryWorkflows.push('Score Calculation and Result Recording');
  }

  if (lower.includes('reconnect') || lower.includes('disconnect') || lower.includes('drop')) {
    capabilities.push({
      id: createDeterministicRequirementId('Session Reconnection', 'Handling disconnects, state recovery, and seat re-association upon reconnection.'),
      title: 'Session Reconnection',
      description: 'Handling client disconnects, preserving game state, and re-attaching dropped players.',
      behavior: 'When a player drops connection, their state is held for a grace period; upon reconnect, active state is restored.',
      businessRules: ['Disconnected player state must be preserved for defined grace window', 'State re-synchronization must be atomic'],
      source: 'PRODUCT_OWNER_DISCOVERY',
    });
    primaryWorkflows.push('Player Reconnection Flow');
  }

  if (lower.includes('okey') || lower.includes('game') || lower.includes('board') || lower.includes('turn')) {
    capabilities.push({
      id: createDeterministicRequirementId('Game Engine & Turn Rules', 'Authoritative game mechanics, turn management, tile distribution, and victory evaluation.'),
      title: 'Game Engine & Turn Rules',
      description: 'Authoritative gameplay logic, turn progression, tile/card manipulation, and win validation.',
      behavior: 'Server controls turn sequence, validates actions, advances state, and declares match winner.',
      businessRules: ['Turn timeouts must forfeit or pass turn', 'Move validation must run on server authority'],
      source: 'PRODUCT_OWNER_DISCOVERY',
    });
    primaryWorkflows.push('Active Game Round Execution');
  }

  // If no capabilities detected from keywords, create baseline capability from prompt
  if (capabilities.length === 0) {
    capabilities.push({
      id: createDeterministicRequirementId('Core Functionality', text),
      title: 'Core Functionality',
      description: text,
      behavior: 'System executes core functional capabilities requested by Product Owner.',
      businessRules: [],
      source: 'PRODUCT_OWNER_DISCOVERY',
    });
  }

  // 4. Non-Functional Requirements
  const performance: string[] = [];
  const security: string[] = [];
  const reliability: string[] = [];
  const scalability: string[] = [];
  const availability: string[] = [];
  const usability: string[] = [];
  const compatibility: string[] = [];

  if (lower.includes('online') || lower.includes('realtime') || lower.includes('game') || lower.includes('4-player')) {
    performance.push('Low-latency state synchronization (< 150ms round-trip under normal conditions)');
    reliability.push('Resilient connection handling with automated heartbeat ping/pong');
    availability.push('Graceful handling of dropped socket connections');
  }

  if (lower.includes('account') || lower.includes('auth')) {
    security.push('Secure password hashing or OAuth token verification; protection against unauthorized access');
  }

  if (platformConstraints.includes('Mobile (iOS/Android responsive or native)')) {
    usability.push('Touch-friendly mobile viewport responsive design');
    compatibility.push('Modern mobile and desktop browser compatibility');
  }

  // 5. Technology Constraints
  const requiredTechnologies: string[] = [];
  const preferredTechnologies: string[] = [];
  const prohibitedTechnologies: string[] = [];

  if (lower.includes('typescript')) requiredTechnologies.push('TypeScript');
  if (lower.includes('react')) preferredTechnologies.push('React');
  if (lower.includes('node')) preferredTechnologies.push('Node.js');
  if (lower.includes('python')) requiredTechnologies.push('Python');
  if (lower.includes('postgres') || lower.includes('postgresql')) preferredTechnologies.push('PostgreSQL');
  if (lower.includes('sqlite')) preferredTechnologies.push('SQLite');

  // 6. Architecture & Data Storage
  const architecturalConstraints: string[] = [];
  const integrationRequirements: string[] = [];
  const dataStorageExpectations: string[] = [];
  let deploymentModel: string | undefined;

  if (lower.includes('online') || lower.includes('multiplayer') || lower.includes('reconnect')) {
    architecturalConstraints.push('Authoritative server architecture with WebSocket or WebTransport real-time channels');
  }

  if (lower.includes('postgres') || lower.includes('postgresql')) {
    dataStorageExpectations.push('PostgreSQL relational database');
  } else if (lower.includes('sqlite')) {
    dataStorageExpectations.push('SQLite relational database');
  } else if (lower.includes('mongo') || lower.includes('mongodb')) {
    dataStorageExpectations.push('MongoDB document database');
  } else if (lower.includes('redis')) {
    dataStorageExpectations.push('Redis key-value store');
  }

  if (lower.includes('cloud') || lower.includes('aws') || lower.includes('gcp')) {
    deploymentModel = 'Cloud Hosted';
  } else if (lower.includes('local') || lower.includes('self-hosted')) {
    deploymentModel = 'Local / Self-Hosted';
  }

  // 7. Acceptance
  const expectedBehavior: string[] = [
    `End-to-end functionality of ${name} according to specified capabilities`,
  ];
  const measurableCriteria: string[] = [
    'Automated test suite passing with zero regressions',
    'Primary workflows demonstrable end-to-end',
  ];
  const definitionOfCompletion: string[] = [
    'All functional capabilities verified by automated tests',
    'No unresolved blocking discovery questions or pending Product Owner decisions',
  ];

  // 8. Risks
  const technicalRisks: DiscoveryRisk[] = [];
  const productRisks: DiscoveryRisk[] = [];
  const operationalRisks: DiscoveryRisk[] = [];
  const dependencies: string[] = [];

  if (lower.includes('reconnect') || lower.includes('online')) {
    technicalRisks.push({
      id: createDeterministicRiskId('TECHNICAL', 'Network desynchronization and race conditions during reconnect'),
      category: 'TECHNICAL',
      statement: 'State drift or race conditions during rapid client disconnect and re-connection cycles',
      impact: 'HIGH',
      mitigation: 'Implement versioned state snapshot and server-authoritative event replay sequence',
    });
  }

  return {
    projectIdentity: {
      name,
      purpose,
      desiredOutcome,
    },
    productScope: {
      inScope: deduplicateStrings(inScope),
      outOfScope: deduplicateStrings(outOfScope),
      targetUsers: deduplicateStrings(targetUsers),
      primaryWorkflows: deduplicateStrings(primaryWorkflows),
    },
    capabilities: deduplicateRequirements(capabilities),
    behaviors: deduplicateStrings(behaviors),
    businessRules: deduplicateStrings(businessRules),
    nonFunctional: {
      performance: deduplicateStrings(performance),
      security: deduplicateStrings(security),
      reliability: deduplicateStrings(reliability),
      scalability: deduplicateStrings(scalability),
      availability: deduplicateStrings(availability),
      usability: deduplicateStrings(usability),
      compatibility: deduplicateStrings(compatibility),
    },
    technology: {
      requiredTechnologies: deduplicateStrings(requiredTechnologies),
      preferredTechnologies: deduplicateStrings(preferredTechnologies),
      prohibitedTechnologies: deduplicateStrings(prohibitedTechnologies),
      platformConstraints: deduplicateStrings(platformConstraints),
    },
    architecture: {
      architecturalConstraints: deduplicateStrings(architecturalConstraints),
      integrationRequirements: deduplicateStrings(integrationRequirements),
      deploymentModel,
      dataStorageExpectations: deduplicateStrings(dataStorageExpectations),
    },
    acceptance: {
      expectedBehavior: deduplicateStrings(expectedBehavior),
      measurableCriteria: deduplicateStrings(measurableCriteria),
      definitionOfCompletion: deduplicateStrings(definitionOfCompletion),
    },
    risks: {
      technicalRisks,
      productRisks,
      operationalRisks,
      dependencies: deduplicateStrings(dependencies),
    },
  };
}
