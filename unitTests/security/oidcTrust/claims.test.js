'use strict';

const assert = require('node:assert');
const {
	splitWorkflowPath,
	normalizeTokenClaims,
	matchTrustPolicyClaims,
	validateTrustPolicyClaims,
} = require('#src/security/oidcTrust/claims');

// A representative GitHub Actions identity token payload, as emitted for a push to main running a
// job that declares `environment: production`.
const GITHUB_CLAIMS = Object.freeze({
	iss: 'https://token.actions.githubusercontent.com',
	aud: 'https://my-instance.harperdb.io:9925/',
	sub: 'repo:HarperFast/my-app:environment:production',
	repository: 'HarperFast/my-app',
	repository_id: '67890',
	repository_owner: 'HarperFast',
	repository_owner_id: '12345',
	workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main',
	job_workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main',
	environment: 'production',
	ref: 'refs/heads/main',
	ref_type: 'branch',
	event_name: 'push',
	runner_environment: 'github-hosted',
	jti: 'e5f7a0c2-0000-4000-8000-000000000001',
});

// The smallest policy that passes validation, reused as a base so each validation test varies one thing.
const VALID_POLICY_CLAIMS = Object.freeze({
	repository_id: '67890',
	workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main',
});

describe('oidcTrust claims', () => {
	describe('splitWorkflowPath', () => {
		it('strips the ref from a workflow reference', () => {
			assert.strictEqual(
				splitWorkflowPath('HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main'),
				'HarperFast/my-app/.github/workflows/deploy.yml'
			);
		});

		it('splits on the ref qualifier, not on an @ inside the branch name', () => {
			assert.strictEqual(
				splitWorkflowPath('HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/release@2'),
				'HarperFast/my-app/.github/workflows/deploy.yml'
			);
		});

		it('handles a tag ref', () => {
			assert.strictEqual(
				splitWorkflowPath('HarperFast/my-app/.github/workflows/release.yml@refs/tags/v1.2.3'),
				'HarperFast/my-app/.github/workflows/release.yml'
			);
		});

		it('returns undefined rather than guessing when the value is not ref-qualified', () => {
			assert.strictEqual(splitWorkflowPath('HarperFast/my-app/.github/workflows/deploy.yml'), undefined);
			assert.strictEqual(splitWorkflowPath('no-at-sign'), undefined);
		});

		it('returns undefined for non-string input', () => {
			assert.strictEqual(splitWorkflowPath(undefined), undefined);
			assert.strictEqual(splitWorkflowPath(null), undefined);
			assert.strictEqual(splitWorkflowPath(42), undefined);
		});
	});

	describe('normalizeTokenClaims', () => {
		it('derives workflow_path and job_workflow_path', () => {
			const claims = normalizeTokenClaims(GITHUB_CLAIMS);
			assert.strictEqual(claims.workflow_path, 'HarperFast/my-app/.github/workflows/deploy.yml');
			assert.strictEqual(claims.job_workflow_path, 'HarperFast/my-app/.github/workflows/deploy.yml');
		});

		it('preserves the original claims', () => {
			const claims = normalizeTokenClaims(GITHUB_CLAIMS);
			assert.strictEqual(claims.repository_id, '67890');
			assert.strictEqual(claims.environment, 'production');
			assert.strictEqual(claims.workflow_ref, GITHUB_CLAIMS.workflow_ref);
		});

		it('does not mutate the input', () => {
			const payload = { ...GITHUB_CLAIMS };
			normalizeTokenClaims(payload);
			assert.strictEqual(payload.workflow_path, undefined);
		});

		it('omits a derived claim when the reference is not ref-qualified', () => {
			const claims = normalizeTokenClaims({ workflow_ref: 'owner/repo/.github/workflows/deploy.yml' });
			assert.strictEqual(claims.workflow_path, undefined);
		});

		// An issuer that one day emits workflow_path itself must win over our derivation, otherwise a
		// policy written against the real claim would be matched against a value we invented.
		it('does not displace a claim the token already carries', () => {
			const claims = normalizeTokenClaims({
				workflow_ref: 'owner/repo/.github/workflows/deploy.yml@refs/heads/main',
				workflow_path: 'issuer-supplied',
			});
			assert.strictEqual(claims.workflow_path, 'issuer-supplied');
		});
	});

	describe('matchTrustPolicyClaims', () => {
		it('matches when every constraint is satisfied', () => {
			const claims = normalizeTokenClaims(GITHUB_CLAIMS);
			const reason = matchTrustPolicyClaims(claims, {
				repository_id: '67890',
				repository_owner_id: '12345',
				workflow_ref: GITHUB_CLAIMS.workflow_ref,
				environment: 'production',
				runner_environment: 'github-hosted',
			});
			assert.strictEqual(reason, undefined);
		});

		it('accepts any value from a set', () => {
			const claims = normalizeTokenClaims(GITHUB_CLAIMS);
			const reason = matchTrustPolicyClaims(claims, {
				repository_id: '67890',
				workflow_ref: GITHUB_CLAIMS.workflow_ref,
				event_name: ['push', 'workflow_dispatch'],
			});
			assert.strictEqual(reason, undefined);
		});

		it('rejects a value outside the set', () => {
			const claims = normalizeTokenClaims(GITHUB_CLAIMS);
			const reason = matchTrustPolicyClaims(claims, {
				repository_id: '67890',
				event_name: ['workflow_dispatch', 'schedule'],
			});
			assert.ok(reason, 'expected a mismatch reason');
			assert.match(reason, /event_name/);
		});

		// The central fail-closed property: a constrained claim the token does not carry must deny,
		// so a policy cannot be silently weakened by an issuer that stops emitting a claim.
		it('rejects when a constrained claim is absent from the token', () => {
			const { environment: _environment, ...withoutEnvironment } = GITHUB_CLAIMS;
			const claims = normalizeTokenClaims(withoutEnvironment);
			const reason = matchTrustPolicyClaims(claims, {
				repository_id: '67890',
				environment: 'production',
			});
			assert.ok(reason, 'expected a mismatch reason');
			assert.match(reason, /environment/);
		});

		it('rejects an empty-string claim value', () => {
			const claims = normalizeTokenClaims({ ...GITHUB_CLAIMS, environment: '' });
			const reason = matchTrustPolicyClaims(claims, { environment: 'production' });
			assert.ok(reason, 'expected a mismatch reason');
		});

		it('rejects a policy that constrains nothing', () => {
			const claims = normalizeTokenClaims(GITHUB_CLAIMS);
			const reason = matchTrustPolicyClaims(claims, {});
			assert.ok(reason, 'expected a rejection for an unconstrained policy');
		});

		it('compares a numerically-encoded claim as a string', () => {
			const claims = normalizeTokenClaims({ ...GITHUB_CLAIMS, repository_id: 67890 });
			assert.strictEqual(matchTrustPolicyClaims(claims, { repository_id: '67890' }), undefined);
		});

		it('refuses to compare a non-scalar claim', () => {
			for (const value of [true, { nested: 'object' }, ['array'], null]) {
				const claims = normalizeTokenClaims({ ...GITHUB_CLAIMS, environment: value });
				assert.ok(
					matchTrustPolicyClaims(claims, { environment: 'production' }),
					`expected rejection for ${JSON.stringify(value)}`
				);
			}
		});

		it('matches on the derived workflow_path so a tag release can pin the file', () => {
			const tagRun = normalizeTokenClaims({
				...GITHUB_CLAIMS,
				workflow_ref: 'HarperFast/my-app/.github/workflows/release.yml@refs/tags/v1.2.3',
				ref: 'refs/tags/v1.2.3',
				ref_type: 'tag',
			});
			const reason = matchTrustPolicyClaims(tagRun, {
				repository_id: '67890',
				workflow_path: 'HarperFast/my-app/.github/workflows/release.yml',
				environment: 'production',
			});
			assert.strictEqual(reason, undefined);
		});
	});

	describe('validateTrustPolicyClaims', () => {
		it('accepts a repository pin plus a ref-qualified workflow pin', () => {
			assert.doesNotThrow(() => validateTrustPolicyClaims({ ...VALID_POLICY_CLAIMS }));
		});

		it('accepts a workflow path pinned by an environment gate', () => {
			assert.doesNotThrow(() =>
				validateTrustPolicyClaims({
					repository_id: '67890',
					workflow_path: 'HarperFast/my-app/.github/workflows/release.yml',
					environment: 'production',
				})
			);
		});

		it('rejects a non-object', () => {
			for (const value of [undefined, null, 'claims', 42, ['repository_id']]) {
				assert.throws(() => validateTrustPolicyClaims(value), /claims must be an object/);
			}
		});

		it('rejects an empty object', () => {
			assert.throws(() => validateTrustPolicyClaims({}), /at least one claim/);
		});

		it('rejects an empty accepted-value set', () => {
			assert.throws(() => validateTrustPolicyClaims({ ...VALID_POLICY_CLAIMS, event_name: [] }), /at least one value/);
		});

		it('rejects non-string and empty-string values', () => {
			assert.throws(() => validateTrustPolicyClaims({ ...VALID_POLICY_CLAIMS, environment: '' }), /non-empty/);
			assert.throws(() => validateTrustPolicyClaims({ ...VALID_POLICY_CLAIMS, environment: 42 }), /non-empty/);
			assert.throws(() => validateTrustPolicyClaims({ ...VALID_POLICY_CLAIMS, event_name: ['push', ''] }), /non-empty/);
		});

		// repository_owner identifies an org, not a repository — pinning it would admit every repo in
		// the org, which is exactly the over-broad policy this validation exists to prevent.
		it('rejects a policy with no repository pin', () => {
			assert.throws(
				() =>
					validateTrustPolicyClaims({
						repository_owner: 'HarperFast',
						workflow_ref: VALID_POLICY_CLAIMS.workflow_ref,
					}),
				/pin the repository/
			);
		});

		it('rejects a policy with no workflow pin', () => {
			assert.throws(
				() => validateTrustPolicyClaims({ repository_id: '67890', environment: 'production' }),
				/pin the workflow/
			);
		});

		// The npm-style "repository + workflow filename" policy: any branch that can be pushed can run
		// the workflow and mint a token. Refuse it unless something gates the ref.
		it('rejects a workflow pin with no ref gate', () => {
			assert.throws(
				() =>
					validateTrustPolicyClaims({
						repository_id: '67890',
						workflow_path: 'HarperFast/my-app/.github/workflows/deploy.yml',
					}),
				/gate the ref/
			);
		});

		it('does not accept ref_type alone as a ref gate', () => {
			assert.throws(
				() =>
					validateTrustPolicyClaims({
						repository_id: '67890',
						workflow_path: 'HarperFast/my-app/.github/workflows/release.yml',
						ref_type: 'tag',
					}),
				/gate the ref/
			);
		});

		it('treats a ref-qualified workflow_ref as both the workflow pin and the ref gate', () => {
			assert.doesNotThrow(() =>
				validateTrustPolicyClaims({
					repository: 'HarperFast/my-app',
					job_workflow_ref: VALID_POLICY_CLAIMS.workflow_ref,
				})
			);
		});
	});
});
