/**
 * Client for the CODA clinical terminology API (v1). No runtime dependencies: uses the global
 * `fetch` (Node 18+, browsers, Deno, Bun). See ../README.md for the shared contract.
 */

export interface CodaClientOptions {
  /** CODA base URL, e.g. https://coda.example.org */
  baseUrl: string;
  /** A fixed bearer token, or a function returning one (called before every request). */
  token: string | (() => string | Promise<string>);
  /** Per-attempt timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Retries after 429, 503 or a network failure (default 2). */
  maxRetries?: number;
  /** Custom fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export type ValidationOutcome = 'valid' | 'inactive' | 'invalid' | 'unknown' | 'unsupported' | 'provider-unavailable';

export interface SystemRef { system: string; version?: string }

export interface CodingItem { system: string; code: string; version?: string; display?: string; valueSetUrl?: string }

export interface Issue { severity: 'information' | 'warning' | 'error'; code: string; message: string }

export interface ValidationResult {
  requestId: string;
  outcome: ValidationOutcome;
  systemUri: string;
  version: string | null;
  code: string;
  display: string | null;
  issues: Issue[];
}

export interface Candidate {
  systemUri: string;
  editionUri: string | null;
  version: string;
  code: string;
  display: string;
  active: boolean;
  matchKind: string;
  score: number;
  evidence: string[];
}

export interface SearchGroup {
  systemUri: string;
  key: string;
  version: string | null;
  status: 'ok' | 'unsupported-version' | 'unsupported-capability' | 'provider-unavailable';
  candidates: Candidate[];
  total: number | null;
  nextOffset: number | null;
  message: string | null;
}

export interface SearchResponse {
  requestId: string;
  groups: SearchGroup[];
  warnings: string[];
  [extra: string]: unknown;
}

export interface Concept {
  requestId: string;
  systemUri: string;
  editionUri: string | null;
  version: string;
  code: string;
  display: string;
  active: boolean;
  designations: { value: string; language: string; use: string }[];
  parentCodes: string[];
  properties: Record<string, string>;
}

export interface QualityReport {
  requestId: string;
  summary: {
    total: number; valid: number; inactive: number; invalid: number; unknownSystem: number; unsupported: number;
    providerUnavailable: number; displayMismatch: number; notInValueSet: number; qualityScore: number | null;
  };
  codingsFound: number;
  truncated: boolean;
  items: (CodingItem & { index: number; path: string | null; resourceType: string | null; outcome: ValidationOutcome; issues: Issue[] })[];
}

export interface Expansion {
  url: string; key: string; version: string; status: string; total: number; offset: number;
  contains: { system: string; systemVersion: string; code: string; display: string }[];
}

export interface PhraseAnalysis {
  status: 'ready-for-review' | 'needs-clarification' | 'no-candidate';
  mode: 'ai' | 'deterministic';
  degraded: boolean;
  degradedReason: string | null;
  interpretation: string | null;
  clarificationQuestion: string | null;
  candidates: { systemUri: string; systemKey: string; version: string; code: string; display: string; rationale: string | null; evidence: string[]; validation: ValidationOutcome }[];
  rejected: { system: string; code: string; version: string | null; reason: string }[];
  warnings: string[];
  requiresHumanReview: true;
  [extra: string]: unknown;
}

/** Opens a CODA Connect session for an EMR (or another system). Phrases travel in the body, never a URL. */
export interface ConnectSessionRequest {
  /** The Connect app id (Developer hub, Connected apps). */
  appId: string;
  /** The clinical phrase only: no names, record numbers or dates. */
  text?: string;
  /** Terminology URIs to offer; omit for CODA's defaults. */
  systems?: string[];
  /** Restrict choices to a value set (key or canonical URL). */
  valueSet?: string;
  purpose?: string;
  maxSelections?: number;
  /** Registered origin that receives the result in the browser. */
  returnOrigin?: string;
  /** Also deliver connect.selection.completed by webhook (default true). */
  webhook?: boolean;
  expiresInMinutes?: number;
  /** Opaque token your EMR generates and maps (e.g. a random UUID); never an MRN or a hash of one. */
  patientRef?: string;
  /** Opaque encounter token, same rules as patientRef. */
  encounterRef?: string;
  /**
   * Your signed-in user, when calling with an integration key: the launchUrl then signs them into
   * this one session without a CODA login. `ref` is your opaque user id; `name` is shown in CODA.
   */
  clinician?: { ref: string; name?: string };
}

export interface ConnectSelection {
  system: string;
  systemKey: string;
  version: string;
  code: string;
  display: string;
  coding: { system: string; version: string; code: string; display: string };
  /** HL7 v2 CWE: code^display^system. */
  cwe: string;
}

export interface ConnectSession {
  id: string;
  appId: string;
  appName: string;
  status: 'open' | 'completed' | 'cancelled' | 'expired';
  purpose: string;
  /** Open this for the clinician (pop-up, iframe or new tab). Null once the session is closed. */
  launchUrl: string | null;
  expiresAt: string;
  patientRef?: string | null;
  encounterRef: string | null;
  result: { sessionId: string; status: 'completed'; completedAt: string; completedBy: string; patientRef?: string | null; encounterRef: string | null; selections: ConnectSelection[] } | null;
  [extra: string]: unknown;
}

/** An RFC 7807 problem from CODA with its stable error code. */
export class CodaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly correlationId: string | null,
    readonly retryable: boolean,
  ) {
    super(`${code} (${status}): ${detail}`);
    this.name = 'CodaApiError';
  }
}

const RETRYABLE = new Set([429, 503]);

export class CodaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: CodaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  systems(): Promise<unknown[]> {
    return this.send('GET', '/api/v1/systems');
  }

  lookup(system: string, code: string, version?: string): Promise<Concept> {
    return this.send('GET', `/api/v1/concepts/lookup?${query({ system, code, version })}`);
  }

  search(queryText: string, systems: SystemRef[], opts: { count?: number; includeInactive?: boolean } = {}): Promise<SearchResponse> {
    return this.send('POST', '/api/v1/search', { query: queryText, systems, ...opts });
  }

  validate(system: string, code: string, opts: { version?: string; display?: string; valueSetUrl?: string } = {}): Promise<ValidationResult> {
    return this.send('POST', '/api/v1/codes/validate', { system, code, ...opts });
  }

  validateBatch(items: CodingItem[]): Promise<QualityReport> {
    return this.send('POST', '/api/v1/codes/validate-batch', { items });
  }

  /** Validates every Coding in a FHIR R4 resource or Bundle (object or JSON text). */
  validateFhir(resource: object | string, valueSet?: string): Promise<QualityReport> {
    const body = typeof resource === 'string' ? resource : JSON.stringify(resource);
    return this.send('POST', `/api/v1/codes/validate-fhir${valueSet ? `?${query({ valueSet })}` : ''}`, new Raw(body, 'application/fhir+json'));
  }

  expand(valueSet: string, opts: { filter?: string; offset?: number; count?: number } = {}): Promise<Expansion> {
    return this.send('POST', '/api/v1/expand', { valueSet, ...opts });
  }

  translate(system: string, code: string): Promise<unknown> {
    return this.send('POST', '/api/v1/translate', { system, code });
  }

  /** Grounded suggestions for a clinical phrase. Every candidate needs human review. */
  async analyzePhrase(phrase: string, systems: SystemRef[]): Promise<PhraseAnalysis> {
    const r = await this.send<{ result: PhraseAnalysis }>('POST', '/api/v1/phrases/analyze', { phrase, systems });
    return r.result;
  }

  /** Records a human-reviewed decision; reuse the idempotency key when retrying the same decision. */
  recordDecision(request: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    if (!idempotencyKey) throw new TypeError('idempotencyKey is required');
    return this.send('POST', '/api/v1/decisions', request, { 'Idempotency-Key': idempotencyKey });
  }

  /**
   * Opens a CODA Connect session. Call it from your server with an integration key as the token;
   * with `clinician`, the returned launchUrl opens CODA already signed in for that one session.
   */
  openConnectSession(request: ConnectSessionRequest): Promise<ConnectSession> {
    if (!request?.appId) throw new TypeError('appId is required');
    return this.send('POST', '/api/v1/connect/sessions', request);
  }

  /** A session and, once the clinician has finished, its result (also delivered by webhook). */
  getConnectSession(id: string): Promise<ConnectSession> {
    return this.send('GET', `/api/v1/connect/sessions/${encodeURIComponent(id)}`);
  }

  private async send<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const requestId = newId();
    for (let attempt = 0; ; attempt++) {
      const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Request-Id': requestId, ...extra };
      let payload: string | undefined;
      if (body instanceof Raw) {
        headers['Content-Type'] = body.mediaType;
        payload = body.text;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body, (_k, v) => (v === undefined ? undefined : v));
      }

      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.fetchImpl(this.baseUrl + path, { method, headers, body: payload, signal: controller.signal });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await delay(backoff(attempt, null));
          continue;
        }
        throw new CodaApiError(0, 'NETWORK_ERROR', `The CODA API could not be reached: ${(e as Error).message}`, requestId, true);
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return (await response.json()) as T;

      const error = await problem(response, requestId);
      if (attempt < this.maxRetries && RETRYABLE.has(response.status)) {
        await delay(backoff(attempt, response.headers.get('Retry-After')));
        continue;
      }
      throw error;
    }
  }
}

class Raw {
  constructor(readonly text: string, readonly mediaType: string) {}
}

async function problem(response: Response, requestId: string): Promise<CodaApiError> {
  let p: Record<string, unknown> = {};
  try {
    p = (await response.json()) as Record<string, unknown>;
  } catch {
    // Not a problem document.
  }
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  return new CodaApiError(response.status, str('code') ?? `HTTP_${response.status}`, str('detail') ?? str('title') ?? response.statusText,
    str('correlationId') ?? requestId, p.retryable === true);
}

function backoff(attempt: number, retryAfter: string | null): number {
  let ms = 250 * 2 ** attempt;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
  }
  return Math.min(Math.max(ms, 0), 10_000);
}

function query(params: Record<string, string | undefined>): string {
  return Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&');
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? Math.random().toString(16).slice(2) + Date.now().toString(16);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verifies a CODA webhook (Standard Webhooks): `webhook-id`, `webhook-timestamp` and
 * `webhook-signature` headers, HMAC-SHA256 over "id.timestamp.body" with the endpoint secret
 * ("whsec_..."). Pass the raw request body exactly as received. Uses Web Crypto (Node 18+, browsers).
 */
export async function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined> | Headers,
  body: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<boolean> {
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    const entry = Object.entries(headers as Record<string, string | string[] | undefined>).find(([k]) => k.toLowerCase() === name);
    const value = entry?.[1];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
  };
  const id = get('webhook-id');
  const timestamp = get('webhook-timestamp');
  const signature = get('webhook-signature');
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;

  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = 'v1,' + btoa(String.fromCharCode(...mac));
  return signature.split(' ').some((candidate) => constantTimeEqual(candidate, expected));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
