'use strict';

const assert = require('node:assert');
const { matchTrustPolicyClaims, validateClaimConstraintShape } = require('#src/security/authn/oidc/claims');

// Deliberately not a GitHub token: this layer must not know which issuer minted anything.
const CLAIMS = Object.freeze({
	iss: 'https://oidc.example.com',
	aud: 'https://my-instance.harperdb.io:9925/',
	sub: 'system:serviceaccount:prod:deployer',
	namespace: 'prod',
	service_account: 'deployer',
	numeric_id: '67890',
	exp: 1_800_000_300,
});

describe('oidc claims', () => {
	describe('matchTrustPolicyClaims', () => {
		it('matches when every constraint is satisfied', () => {
			const reason = matchTrustPolicyClaims(CLAIMS, {
				sub: 'system:serviceaccount:prod:deployer',
				namespace: 'prod',
			});
			assert.strictEqual(reason, undefined);
		});

		it('accepts any value from a set', () => {
			assert.strictEqual(matchTrustPolicyClaims(CLAIMS, { namespace: ['prod', 'staging'] }), undefined);
		});

		it('rejects a value outside the set', () => {
			const reason = matchTrustPolicyClaims(CLAIMS, { namespace: ['staging', 'dev'] });
			assert.ok(reason);
			assert.match(reason, /namespace/);
		});

		// The central fail-closed property: a constrained claim the token does not carry must deny,
		// so a policy cannot be silently weakened by an issuer that stops emitting a claim.
		it('rejects when a constrained claim is absent from the token', () => {
			const reason = matchTrustPolicyClaims(CLAIMS, { environment: 'production' });
			assert.ok(reason);
			assert.match(reason, /environment/);
		});

		it('rejects an empty-string claim value', () => {
			assert.ok(matchTrustPolicyClaims({ ...CLAIMS, namespace: '' }, { namespace: 'prod' }));
		});

		it('rejects a policy that constrains nothing', () => {
			assert.ok(matchTrustPolicyClaims(CLAIMS, {}));
		});

		it('compares a numerically-encoded claim as a string', () => {
			assert.strictEqual(matchTrustPolicyClaims({ ...CLAIMS, numeric_id: 67890 }, { numeric_id: '67890' }), undefined);
		});

		it('refuses to compare a non-scalar claim', () => {
			for (const value of [true, { nested: 'object' }, ['array'], null]) {
				assert.ok(
					matchTrustPolicyClaims({ ...CLAIMS, namespace: value }, { namespace: 'prod' }),
					`expected rejection for ${JSON.stringify(value)}`
				);
			}
		});
	});

	// Shape only — whether a claim set is *specific enough* is the provider profile's call.
	describe('validateClaimConstraintShape', () => {
		it('accepts a well-formed constraint set', () => {
			assert.doesNotThrow(() => validateClaimConstraintShape({ sub: 'x', namespace: ['a', 'b'] }));
		});

		it('rejects a non-object', () => {
			for (const value of [undefined, null, 'claims', 42, ['sub']]) {
				assert.throws(() => validateClaimConstraintShape(value), /claims must be an object/);
			}
		});

		it('rejects an empty object', () => {
			assert.throws(() => validateClaimConstraintShape({}), /at least one claim/);
		});

		it('rejects an empty accepted-value set', () => {
			assert.throws(() => validateClaimConstraintShape({ sub: 'x', event_name: [] }), /at least one value/);
		});

		it('rejects non-string and empty-string values', () => {
			assert.throws(() => validateClaimConstraintShape({ sub: '' }), /non-empty/);
			assert.throws(() => validateClaimConstraintShape({ sub: 42 }), /non-empty/);
			assert.throws(() => validateClaimConstraintShape({ sub: ['x', ''] }), /non-empty/);
		});
	});
});
