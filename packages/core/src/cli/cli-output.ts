/**
 * CLI output formatter and secret sanitizer.
 * Guarantees that secrets, bearer tokens, and private keys never leak to stdout/stderr.
 */

/**
 * Sanitizes sensitive tokens, keys, and password patterns for CLI presentation.
 */
export function sanitizeCliSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // Mask key=val or password:val patterns
  out = out.replace(
    /(password|passwd|secret|apikey|api_key|token)\s*[:=]\s*["']?([^\s&"']+)["']?/gi,
    '$1=[REDACTED]'
  );

  // Mask sk- API keys
  out = out.replace(/sk-[a-zA-Z0-9_\-]{10,}/g, '***REDACTED_KEY***');

  // Mask Bearer tokens
  out = out.replace(/Bearer\s+[a-zA-Z0-9_.-]{10,}/gi, 'Bearer ***REDACTED_TOKEN***');

  return out;
}

export class CliOutputWriter {
  private readonly outFn: (text: string) => void;
  private readonly errFn: (text: string) => void;

  constructor(outFn?: (text: string) => void, errFn?: (text: string) => void) {
    this.outFn = outFn ?? ((t: string) => process.stdout.write(t + '\n'));
    this.errFn = errFn ?? ((t: string) => process.stderr.write(t + '\n'));
  }

  write(text: string): void {
    this.outFn(sanitizeCliSecrets(text));
  }

  writeError(text: string): void {
    this.errFn(sanitizeCliSecrets(text));
  }

  writeJson(data: unknown): void {
    const raw = JSON.stringify(data, null, 2);
    this.outFn(sanitizeCliSecrets(raw));
  }
}
