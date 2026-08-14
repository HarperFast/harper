/**
 * OIDC discovery and JWKS retrieval for trusted publishing (#2171).
 *
 * The issuer's signing keys are the root of trust for an exchanged token, so this module is
 * deliberately conservative: HTTPS only, bounded response size, bounded fetch time, and a rate limit
 * on the refetch that an unrecognized `kid` triggers. That last one matters because the exchange
 * endpoint is unauthenticated — without it, a stream of forged `kid`s becomes one outbound fetch per
 * request, against the issuer and on Harper's own event loop.
 */

import { createPublicKey, type KeyObject } from 'node:crypto';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';

const logger = loggerWithTag('oidc-trust');

const DISCOVERY_PATH = '/.well-known/openid-configuration';
/** How long a fetched key set is served without revalidation. */
const JWKS_CACHE_TTL_MS = 3_600_000;
/** Floor between refetches triggered by an unrecognized `kid`. */
const MIN_REFETCH_INTERVAL_MS = 60_000;
/**
 * How long a cached key set may still be used after a refetch fails. Issuers rotate signing keys
 * rarely, so a network blip should not break deploys — but an unbounded fallback would keep honoring
 * a key set long after a key was pulled.
 */
const STALE_KEY_GRACE_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1_048_576;
/**
 * Asymmetric key types only. An `oct` (symmetric) key in a JWKS is the setup for the classic
 * algorithm-confusion attack, where a public value is replayed as an HMAC secret.
 */
const SUPPORTED_KEY_TYPES = ['RSA', 'EC'];

interface IssuerKeys {
	keys: Map<string, KeyObject>;
	fetchedAt: number;
}

const issuerKeyCache = new Map<string, IssuerKeys>();
const inFlightLoads = new Map<string, Promise<IssuerKeys>>();
/**
 * When an unrecognized `kid` last drove a refetch, per issuer. Kept outside the cache entry on
 * purpose: the entry is replaced by every successful fetch, and a rate limit that resets whenever it
 * fires is not a rate limit.
 */
const unknownKidRefetchAt = new Map<string, number>();

/** Drops all cached key sets. Exported for tests and for an operator forcing a re-read. */
export function clearJwksCache(): void {
	issuerKeyCache.clear();
	inFlightLoads.clear();
	unknownKidRefetchAt.clear();
}

/**
 * Validates and canonicalizes an issuer URL. The result is both the cache key and the discovery
 * base, so it has to be stable: a policy stored with a trailing slash and one without must not end
 * up as two entries pointing at the same issuer.
 */
export function normalizeIssuer(issuer: unknown): string {
	if (typeof issuer !== 'string' || issuer === '') throw new ClientError('issuer is required');
	let url: URL;
	try {
		url = new URL(issuer);
	} catch {
		throw new ClientError(`issuer is not a valid URL: ${issuer}`);
	}
	if (url.protocol !== 'https:') throw new ClientError('issuer must be an https URL');
	if (url.search !== '' || url.hash !== '') throw new ClientError('issuer must not carry a query or fragment');
	return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

/**
 * Reads a JSON response with a hard byte ceiling. `content-length` is checked first as a cheap
 * rejection, then the body is counted as it streams, because the header is advisory and a hostile
 * endpoint can simply omit it.
 */
async function readBoundedJson(response: Response, url: string): Promise<any> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new ServerError(`Response from ${url} exceeds ${MAX_RESPONSE_BYTES} bytes`);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	if (response.body) {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			total += chunk.length;
			if (total > MAX_RESPONSE_BYTES) {
				throw new ServerError(`Response from ${url} exceeds ${MAX_RESPONSE_BYTES} bytes`);
			}
			chunks.push(Buffer.from(chunk));
		}
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch (error) {
		throw new ServerError(`Response from ${url} is not valid JSON: ${(error as Error).message}`);
	}
}

async function fetchJson(url: string): Promise<any> {
	let response: Response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: 'application/json' },
			redirect: 'error',
		});
	} catch (error) {
		throw new ServerError(`Could not reach ${url}: ${(error as Error).message}`);
	}
	if (!response.ok) throw new ServerError(`${url} responded ${response.status}`);
	return readBoundedJson(response, url);
}

/**
 * Resolves the issuer's `jwks_uri` via OIDC discovery. The discovery document's own `issuer` must
 * equal the one we asked about — the spec requires it, and it is what stops a misdirected discovery
 * document from quietly re-pointing an issuer we trust.
 */
async function discoverJwksUri(issuer: string): Promise<string> {
	const document = await fetchJson(issuer + DISCOVERY_PATH);
	// normalizeIssuer raises a ClientError, which is the wrong shape for a malformed *server*
	// response — an unparseable `issuer` here is the issuer misbehaving, not the caller.
	let declaredIssuer: string | undefined;
	try {
		declaredIssuer = normalizeIssuer(document?.issuer);
	} catch {
		declaredIssuer = undefined;
	}
	if (declaredIssuer !== issuer) {
		throw new ServerError(`Discovery document at ${issuer} declares a different issuer`);
	}
	const jwksUri = document?.jwks_uri;
	if (typeof jwksUri !== 'string' || !jwksUri.startsWith('https://')) {
		throw new ServerError(`Discovery document at ${issuer} has no https jwks_uri`);
	}
	return jwksUri;
}

/**
 * Converts a JWK to a usable public key, or returns undefined for one we will not honor. A single
 * unusable entry must not poison the whole set: issuers publish keys for other purposes, and future
 * key types should degrade to "not usable here" rather than to a failed fetch.
 */
function toSigningKey(jwk: any): KeyObject | undefined {
	if (!jwk || typeof jwk !== 'object') return undefined;
	if (typeof jwk.kid !== 'string' || jwk.kid === '') return undefined;
	if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
	if (!SUPPORTED_KEY_TYPES.includes(jwk.kty)) return undefined;
	try {
		return createPublicKey({ key: jwk, format: 'jwk' });
	} catch (error) {
		logger.warn?.(`Skipping unusable JWK ${jwk.kid}: ${(error as Error).message}`);
		return undefined;
	}
}

async function fetchIssuerKeys(issuer: string): Promise<IssuerKeys> {
	const jwksUri = await discoverJwksUri(issuer);
	const jwks = await fetchJson(jwksUri);
	if (!Array.isArray(jwks?.keys)) throw new ServerError(`JWKS at ${jwksUri} has no keys array`);

	const keys = new Map<string, KeyObject>();
	for (const jwk of jwks.keys) {
		const key = toSigningKey(jwk);
		if (key) keys.set(jwk.kid, key);
	}
	if (keys.size === 0) throw new ServerError(`JWKS at ${jwksUri} contains no usable signing keys`);

	const entry: IssuerKeys = { keys, fetchedAt: Date.now() };
	issuerKeyCache.set(issuer, entry);
	logger.debug?.(`Loaded ${keys.size} signing key(s) for ${issuer}`);
	return entry;
}

/** Loads an issuer's keys, collapsing concurrent callers onto one fetch. */
function loadIssuerKeys(issuer: string): Promise<IssuerKeys> {
	const existing = inFlightLoads.get(issuer);
	if (existing) return existing;

	const load = fetchIssuerKeys(issuer).finally(() => inFlightLoads.delete(issuer));
	inFlightLoads.set(issuer, load);
	return load;
}

/**
 * Resolves the public key an issuer used to sign a token, by `kid`.
 *
 * An unrecognized `kid` against a fresh cache means either a genuine key rotation or a forged
 * header. Both look identical from here, so the refetch that distinguishes them is rate-limited
 * rather than unconditional.
 */
export async function getSigningKey(issuer: string, kid: unknown): Promise<KeyObject> {
	if (typeof kid !== 'string' || kid === '') throw new ClientError('Token has no key id', 401);
	const normalizedIssuer = normalizeIssuer(issuer);
	const now = Date.now();
	const cached = issuerKeyCache.get(normalizedIssuer);

	if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
		const key = cached.keys.get(kid);
		if (key) return key;
		// Unknown kid against a still-fresh set: refetch once, then hold the line for the window. The
		// timestamp is recorded before the fetch so a failing issuer is rate-limited like a succeeding one.
		if (now - (unknownKidRefetchAt.get(normalizedIssuer) ?? 0) < MIN_REFETCH_INTERVAL_MS) {
			throw new ClientError('Token signing key is not recognized', 401);
		}
		unknownKidRefetchAt.set(normalizedIssuer, now);
	}

	let refreshed: IssuerKeys;
	try {
		refreshed = await loadIssuerKeys(normalizedIssuer);
	} catch (error) {
		// Serve a still-recent cached key rather than failing an exchange on a transient outage.
		const staleKey = cached && now - cached.fetchedAt < STALE_KEY_GRACE_MS ? cached.keys.get(kid) : undefined;
		if (!staleKey) throw error;
		logger.warn?.(`Using cached signing key for ${normalizedIssuer}; refresh failed: ${(error as Error).message}`);
		return staleKey;
	}

	const key = refreshed.keys.get(kid);
	if (!key) throw new ClientError('Token signing key is not recognized', 401);
	return key;
}
