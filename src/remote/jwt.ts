// Zero-dependency HS256 JWT sign + verify for the remote viewer token.
//
// HS256 is ~50 lines of crypto.createHmac + base64url, so we keep it in-tree
// instead of pulling `jsonwebtoken` to keep supply-chain surface small.
//
// Token shape:
//   header:  { alg: "HS256", typ: "JWT", kid: "v1" }
//   payload: { iss: "klura-runtime", aud: "klura-viewer",
//              sid, jti, iat, nbf, exp }
//
// Forward-compat notes: - kid is shipped as "v1" from day 1 so multi-key
// rotation can be added later without a breaking protocol change. - 30 second
// default skew tolerance on nbf/exp for future multi-host deployments
// (self-hosted is single-host so this is slack, not a necessity).

import crypto from 'crypto';

const ISSUER = 'klura-runtime';
const AUDIENCE = 'klura-viewer';
const DEFAULT_KID = 'v1';
const KNOWN_KIDS = new Set(['v1']);
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_SKEW_SECONDS = 30;

interface ViewerTokenPayload {
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  sid: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
}

interface SignOptions {
  sid: string;
  secret: string;
  ttlSeconds?: number;
  kid?: string;
  /** Override current time in seconds since epoch (for deterministic tests). */
  now?: number;
}

interface VerifyOptions {
  token: string;
  secret: string;
  expectedSid: string;
  /** Override current time in seconds since epoch (for deterministic tests). */
  now?: number;
  skewSeconds?: number;
}

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function hmacSha256(secret: string, data: string): Buffer {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function fail(): never {
  throw new Error('invalid_token');
}

export function signViewerToken(opts: SignOptions): string {
  const kid = opts.kid ?? DEFAULT_KID;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const iat = opts.now ?? nowSeconds();
  const payload: ViewerTokenPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sid: opts.sid,
    jti: crypto.randomUUID(),
    iat,
    nbf: iat,
    exp: iat + ttl,
  };
  const header = { alg: 'HS256', typ: 'JWT', kid };
  const encHeader = b64urlEncode(JSON.stringify(header));
  const encPayload = b64urlEncode(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const encSig = b64urlEncode(hmacSha256(opts.secret, signingInput));
  return `${signingInput}.${encSig}`;
}

export function verifyViewerToken(opts: VerifyOptions): ViewerTokenPayload {
  if (typeof opts.token !== 'string' || opts.token.length === 0) fail();
  const parts = opts.token.split('.');
  if (parts.length !== 3) fail();
  const [encHeader, encPayload, encSig] = parts;
  if (!encHeader || !encPayload || !encSig) fail();

  // Header check first — cheapest rejection and catches obvious tampering
  // before we spend CPU on HMAC.
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  try {
    header = JSON.parse(b64urlDecode(encHeader).toString('utf8')) as typeof header;
  } catch {
    fail();
  }
  if (header.alg !== 'HS256') fail();
  if (header.typ !== 'JWT') fail();
  if (typeof header.kid !== 'string' || !KNOWN_KIDS.has(header.kid)) fail();

  // Signature check.
  const expectedSig = hmacSha256(opts.secret, `${encHeader}.${encPayload}`);
  const actualSig = b64urlDecode(encSig);
  if (expectedSig.length !== actualSig.length) fail();
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) fail();

  // Payload parse + claim checks.
  let payload: Partial<ViewerTokenPayload> & Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(encPayload).toString('utf8')) as typeof payload;
  } catch {
    fail();
  }
  if (payload.iss !== ISSUER) fail();
  if (payload.aud !== AUDIENCE) fail();
  if (typeof payload.sid !== 'string' || payload.sid !== opts.expectedSid) fail();
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) fail();
  if (
    typeof payload.iat !== 'number' ||
    typeof payload.nbf !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    fail();
  }

  const now = opts.now ?? nowSeconds();
  const skew = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  if (payload.nbf > now + skew) fail();
  if (payload.exp <= now - skew) fail();

  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sid: payload.sid,
    jti: payload.jti,
    iat: payload.iat,
    nbf: payload.nbf,
    exp: payload.exp,
  };
}
