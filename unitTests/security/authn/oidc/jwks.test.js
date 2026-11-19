'use strict';

const assert = require('node:assert');
const { generateKeyPairSync, createPublicKey } = require('node:crypto');
const { getSigningKey, normalizeIssuer, clearJwksCache } = require('#src/security/authn/oidc/jwks');

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const DISCOVERY_URI = ISSUER + '/.well-known/openid-configuration';

describe('oidc jwks', () => {
	describe('normalizeIssuer', () => {
		it('drops a trailing slash so one issuer is one cache entry', () => {
			assert.strictEqual(normalizeIssuer(ISSUER + '/'), ISSUER);
			assert.strictEqual(normalizeIssuer(ISSUER), ISSUER);
		});

		it('keeps a path-qualified issuer', () => {
			assert.strictEqual(normalizeIssuer('https://gitlab.example.com/oidc/'), 'https://gitlab.example.com/oidc');
		});

		it('requires https', () => {
			assert.throws(() => normalizeIssuer('http://token.actions.githubusercontent.com'), /https/);
		});

		it('rejects a query or fragment', () => {
			assert.throws(() => normalizeIssuer(ISSUER + '?a=b'), /query or fragment/);
			assert.throws(() => normalizeIssuer(ISSUER + '#frag'), /query or fragment/);
		});

		it('rejects values that are not URLs', () => {
			for (const value of ['', undefined, null, 42, 'token.actions.githubusercontent.com']) {
				assert.throws(() => normalizeIssuer(value), `expected rejection for ${JSON.stringify(value)}`);
			}
		});
	});

	describe('getSigningKey', () => {
		let realFetch;
		let requestLog;
		let respond;
		let signingJwk;

		before(() => {
			const { publicKey } = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			});
			signingJwk = { ...createPublicKey(publicKey).export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };
		});

		beforeEach(() => {
			clearJwksCache();
			requestLog = [];
			realFetch = globalThis.fetch;
			// Route fetch through a per-test responder so the real caching, discovery, and bounding
			// logic runs — only the network is displaced.
			globalThis.fetch = async (url) => {
				requestLog.push(String(url));
				return respond(String(url));
			};
			respond = (url) => json(url === DISCOVERY_URI ? discoveryDocument() : jwksDocument([signingJwk]));
		});

		afterEach(() => {
			globalThis.fetch = realFetch;
			clearJwksCache();
		});

		function json(body, init) {
			return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' },
				...init,
			});
		}

		function discoveryDocument(overrides = {}) {
			return { issuer: ISSUER, jwks_uri: JWKS_URI, ...overrides };
		}

		function jwksDocument(keys) {
			return { keys };
		}

		it('discovers the JWKS and resolves a key by kid', async () => {
			const key = await getSigningKey(ISSUER, 'key-1');
			assert.strictEqual(key.type, 'public');
			assert.deepStrictEqual(requestLog, [DISCOVERY_URI, JWKS_URI]);
		});

		it('serves later lookups from cache', async () => {
			await getSigningKey(ISSUER, 'key-1');
			await getSigningKey(ISSUER, 'key-1');
			assert.strictEqual(requestLog.length, 2, 'expected no refetch for a cached kid');
		});

		it('treats a trailing slash as the same issuer', async () => {
			await getSigningKey(ISSUER, 'key-1');
			await getSigningKey(ISSUER + '/', 'key-1');
			assert.strictEqual(requestLog.length, 2, 'expected the normalized issuer to hit the same cache entry');
		});

		it('collapses concurrent lookups onto one fetch', async () => {
			const keys = await Promise.all([
				getSigningKey(ISSUER, 'key-1'),
				getSigningKey(ISSUER, 'key-1'),
				getSigningKey(ISSUER, 'key-1'),
			]);
			assert.strictEqual(keys.length, 3);
			assert.deepStrictEqual(requestLog, [DISCOVERY_URI, JWKS_URI]);
		});

		// An unknown kid is either a rotation or a forgery. The first triggers one refetch; repeats
		// inside the rate-limit window must not, or the unauthenticated exchange endpoint becomes a
		// way to drive outbound requests.
		it('refetches once for an unknown kid, then rate-limits', async () => {
			await getSigningKey(ISSUER, 'key-1');
			assert.strictEqual(requestLog.length, 2);

			await assert.rejects(() => getSigningKey(ISSUER, 'forged-kid'), /not recognized/);
			assert.strictEqual(requestLog.length, 4, 'expected one refetch for the unknown kid');

			await assert.rejects(() => getSigningKey(ISSUER, 'forged-kid'), /not recognized/);
			await assert.rejects(() => getSigningKey(ISSUER, 'another-forged-kid'), /not recognized/);
			assert.strictEqual(requestLog.length, 4, 'expected no further refetches inside the window');
		});

		it('picks up a rotated key when the issuer publishes it', async () => {
			await getSigningKey(ISSUER, 'key-1');
			const rotated = { ...signingJwk, kid: 'key-2' };
			respond = (url) => json(url === DISCOVERY_URI ? discoveryDocument() : jwksDocument([signingJwk, rotated]));
			const key = await getSigningKey(ISSUER, 'key-2');
			assert.strictEqual(key.type, 'public');
		});

		it('falls back to a cached key when a refresh fails', async () => {
			await getSigningKey(ISSUER, 'key-1');
			respond = () => {
				throw new Error('network down');
			};
			// The unknown kid forces a refresh, which fails; the still-cached kid must survive it.
			await assert.rejects(() => getSigningKey(ISSUER, 'forged-kid'));
			const key = await getSigningKey(ISSUER, 'key-1');
			assert.strictEqual(key.type, 'public');
		});

		it('rejects a discovery document that declares a different issuer', async () => {
			respond = (url) =>
				json(
					url === DISCOVERY_URI ? discoveryDocument({ issuer: 'https://evil.example.com' }) : jwksDocument([signingJwk])
				);
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /different issuer/);
		});

		it('rejects a non-https jwks_uri', async () => {
			respond = (url) =>
				json(url === DISCOVERY_URI ? discoveryDocument({ jwks_uri: 'http://insecure.example/jwks' }) : {});
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /https jwks_uri/);
		});

		// A symmetric key in a JWKS is the setup for algorithm confusion; it must never become a
		// candidate signing key.
		it('ignores symmetric and non-signing keys', async () => {
			respond = (url) =>
				json(
					url === DISCOVERY_URI
						? discoveryDocument()
						: jwksDocument([
								{ kty: 'oct', kid: 'symmetric', k: 'c2VjcmV0' },
								{ ...signingJwk, kid: 'encryption-only', use: 'enc' },
								signingJwk,
							])
				);
			await assert.rejects(() => getSigningKey(ISSUER, 'symmetric'), /not recognized/);
			await assert.rejects(() => getSigningKey(ISSUER, 'encryption-only'), /not recognized/);
			assert.strictEqual((await getSigningKey(ISSUER, 'key-1')).type, 'public');
		});

		it('rejects a JWKS with no usable keys', async () => {
			respond = (url) =>
				json(url === DISCOVERY_URI ? discoveryDocument() : jwksDocument([{ kty: 'oct', kid: 'x', k: 'c2VjcmV0' }]));
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /no usable signing keys/);
		});

		it('rejects a non-JSON response', async () => {
			respond = () => json('<html>not json</html>');
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /not valid JSON/);
		});

		it('rejects an error status', async () => {
			respond = () => new Response('nope', { status: 503 });
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /responded 503/);
		});

		it('rejects an oversized response body', async () => {
			respond = () => json('x'.repeat(1_100_000));
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /exceeds/);
		});

		it('rejects an oversized declared content-length without reading the body', async () => {
			respond = () =>
				new Response('{}', {
					status: 200,
					headers: { 'content-type': 'application/json', 'content-length': '99999999' },
				});
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'), /exceeds/);
		});

		// The expired-cache half, reachable now that getSigningKey takes a clock. A cached set survives
		// a failed refresh so a network blip does not break deploys — but only for STALE_KEY_GRACE_MS,
		// because `fetchedAt` is advanced ONLY by a successful fetch. Without the ceiling, a key the
		// issuer has pulled stays honored for the whole length of an outage rather than 24h. Both
		// sides are asserted: dropping the bound leaves the grace+1 case passing on the served key,
		// and dropping the grace entirely would take the grace−1 case with it.
		describe('the stale-key grace ceiling', () => {
			const GRACE_MS = 86_400_000;

			async function cacheThenFail() {
				await getSigningKey(ISSUER, 'key-1'); // populate
				respond = () => {
					throw new Error('issuer is down');
				};
			}

			it('still serves a cached key just inside the grace window', async () => {
				await cacheThenFail();
				const key = await getSigningKey(ISSUER, 'key-1', Date.now() + GRACE_MS - 1000);
				assert.strictEqual(key.type, 'public', 'a blip must not break deploys inside the window');
			});

			it('refuses a cached key once the grace window has passed', async () => {
				await cacheThenFail();
				await assert.rejects(
					() => getSigningKey(ISSUER, 'key-1', Date.now() + GRACE_MS + 1000),
					'a pulled key must not be honored indefinitely through an outage'
				);
			});
		});

		// An issuer whose keys we have NEVER cached is the worse half of the outage case: there is no
		// stale key to fall back on, so without a backoff every request rides the full discovery and
		// fetch timeout — and the exchange is unauthenticated, with the issuer chosen from an
		// unverified JWT. Reachable without time travel; the expired-cache half above needs the clock.
		it('stops re-fetching for an issuer whose keys have never been cached', async () => {
			respond = () => {
				throw new Error('issuer is down');
			};

			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'));
			const afterFirst = requestLog.length;
			assert.ok(afterFirst > 0, 'expected the first attempt to actually try');

			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'));
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'));

			assert.strictEqual(
				requestLog.length,
				afterFirst,
				'a failed refresh must suppress further fetches for the backoff interval'
			);
		});

		// The backoff must not outlive the outage: a recovered issuer is picked up once the interval
		// passes, and clearing the cache is the operator's way to force that immediately.
		it('fetches again for a recovered issuer once the failure is cleared', async () => {
			respond = () => {
				throw new Error('issuer is down');
			};
			await assert.rejects(() => getSigningKey(ISSUER, 'key-1'));

			clearJwksCache();
			requestLog.length = 0;
			respond = (url) => json(url === DISCOVERY_URI ? discoveryDocument() : jwksDocument([signingJwk]));

			const key = await getSigningKey(ISSUER, 'key-1');
			assert.strictEqual(key.type, 'public');
			assert.ok(requestLog.length > 0, 'expected the recovered issuer to be fetched again');
		});

		it('requires a key id', async () => {
			for (const kid of ['', undefined, null, 42]) {
				await assert.rejects(() => getSigningKey(ISSUER, kid), /no key id/);
			}
			assert.deepStrictEqual(requestLog, [], 'expected no fetch for a token with no kid');
		});
	});
});
