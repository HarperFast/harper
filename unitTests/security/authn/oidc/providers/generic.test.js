'use strict';

const assert = require('node:assert');
const { genericProfile } = require('#src/security/authn/oidc/providers/generic');
const { profileForIssuer } = require('#src/security/authn/oidc/providers/index');

// Representative subjects from the workload-identity issuers this profile is meant to serve with no
// provider code at all.
const KUBERNETES_SUB = 'system:serviceaccount:prod:deployer';
const SPIFFE_SUB = 'spiffe://example.org/ns/prod/sa/deployer';

describe('generic provider profile', () => {
	it('is the fallback for an unregistered issuer', () => {
		for (const issuer of ['https://kubernetes.default.svc', 'https://accounts.google.com', 'https://gitlab.com']) {
			assert.strictEqual(profileForIssuer(issuer), genericProfile);
		}
	});

	// sub is the one claim every OIDC issuer defines as identifying a single principal, so requiring
	// it is what makes an unregistered issuer safe by default rather than permissive by default.
	describe('assertPolicyIsSpecific', () => {
		it('accepts a policy that pins sub', () => {
			for (const sub of [KUBERNETES_SUB, SPIFFE_SUB, 'deployer@project.iam.gserviceaccount.com']) {
				assert.doesNotThrow(() => genericProfile.assertPolicyIsSpecific({ sub }));
			}
		});

		it('accepts sub alongside further constraints', () => {
			assert.doesNotThrow(() => genericProfile.assertPolicyIsSpecific({ sub: KUBERNETES_SUB, namespace: 'prod' }));
		});

		it('rejects a policy that does not pin sub', () => {
			assert.throws(() => genericProfile.assertPolicyIsSpecific({ namespace: 'prod' }), /must pin `sub`/);
		});

		it('rejects a policy pinning only claims that do not identify a principal', () => {
			assert.throws(
				() => genericProfile.assertPolicyIsSpecific({ aud: 'https://my-instance.harperdb.io:9925/' }),
				/must pin `sub`/
			);
		});
	});

	describe('normalizeClaims', () => {
		it('derives nothing and does not mutate', () => {
			const payload = { sub: KUBERNETES_SUB, namespace: 'prod' };
			const claims = genericProfile.normalizeClaims(payload);
			assert.deepStrictEqual(claims, payload);
			assert.notStrictEqual(claims, payload, 'should be a copy');
		});
	});

	describe('assertAudienceIsSpecific', () => {
		// No known shared default; the required sub pin already binds the policy to one principal.
		it('accepts any audience', () => {
			assert.doesNotThrow(() => genericProfile.assertAudienceIsSpecific('https://github.com/HarperFast'));
		});
	});

	describe('describePrincipal', () => {
		it('is the subject', () => {
			assert.strictEqual(genericProfile.describePrincipal({ sub: SPIFFE_SUB }), SPIFFE_SUB);
		});

		it('tolerates a missing subject', () => {
			assert.strictEqual(typeof genericProfile.describePrincipal({}), 'string');
		});
	});

	it('declares no match-time veto', () => {
		assert.strictEqual(genericProfile.vetoClaims, undefined);
	});
});
