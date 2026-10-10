/**
 * @file trusted-identity-sanitizer.ts
 * @description P18-04 Sensitive Credential & PII Masking Utility for Audit Records.
 *
 * Ensures that bearer tokens, raw JWTs, private keys, client secrets, and sensitive
 * credentials are masked prior to being logged or persisted into HistoryManager.
 */

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /credential/i,
  /privatekey/i,
  /signature/i,
  /bearer/i,
  /apikey/i,
];

/**
 * Masks a token or secret string, preserving only first 4 and last 4 characters if long enough.
 */
export function maskToken(rawToken: string): string {
  if (!rawToken || typeof rawToken !== 'string') {
    return '[MASKED_CREDENTIAL]';
  }
  const trimmed = rawToken.trim();
  if (trimmed.length <= 12) {
    return '***[MASKED]***';
  }
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}...[MASKED]...${suffix}`;
}

/**
 * Recursively walks an object or payload and sanitizes sensitive fields.
 */
export function sanitizeForAudit<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Check if string looks like a JWT (header.payload.signature)
    if (/^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+$/.test(data)) {
      return maskToken(data) as unknown as T;
    }
    // Check if string starts with Bearer
    if (/^bearer\s+/i.test(data)) {
      return `Bearer ${maskToken(data.replace(/^bearer\s+/i, ''))}` as unknown as T;
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForAudit(item)) as unknown as T;
  }

  if (typeof data === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitiveKey) {
        if (typeof value === 'string') {
          sanitizedObj[key] = maskToken(value);
        } else if (value && typeof value === 'object') {
          sanitizedObj[key] = '[MASKED_CREDENTIAL_OBJECT]';
        } else {
          sanitizedObj[key] = '[MASKED]';
        }
      } else {
        sanitizedObj[key] = sanitizeForAudit(value);
      }
    }
    return sanitizedObj as T;
  }

  return data;
}
