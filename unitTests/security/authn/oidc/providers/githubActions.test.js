'use strict';

const assert = require('node:assert');
const { githubActionsProfile, splitWorkflowPath } = require('#src/security/authn/oidc/providers/githubActions');
const { profileForIssuer, genericProfile } = require('#src/security/authn/oidc/providers/index');

const WORKFLOW_REF = 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main';

const GITHUB_CLAIMS = Object.freeze({
	iss: 'https://token.actions.githubusercontent.com',
	sub: 'repo:HarperFast/my-app:environment:production',
	repository: 'HarperFast/my-app',
	repository_id: '67890',
	repository_owner: 'HarperFast',
	repository_owner_id: '12345',
	workflow_ref: WORKFLOW_REF,
	job_workflow_ref: WORKFLOW_REF,
	environment: 'production',
	ref: 'refs/heads/main',
	event_name: 'push',
	run_id: '99',
	actor: 'octocat',
});

const VALID_POLICY_CLAIMS = Object.freeze({ repository_id: '67890', workflow_ref: WORKFLOW_REF });

describe('githubActions provider profile', () => {
	it('is the profile registered for the GitHub Actions issuer', () => {
		assert.strictEqual(profileForIssuer('https://token.actions.githubusercontent.com'), githubActionsProfile);
	});

	it('does not claim other issuers', () => {
		assert.strictEqual(profileForIssuer('https://gitlab.example.com'), genericProfile);
	});

	describe('splitWorkflowPath', () => {
		it('strips the ref', () => {
			assert.strictEqual(splitWorkflowPath(WORKFLOW_REF), 'HarperFast/my-app/.github/workflows/deploy.yml');
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

		it('returns undefined rather than guessing', () => {
			for (const value of ['HarperFast/my-app/.github/workflows/deploy.yml', 'no-at-sign', undefined, null, 42]) {
				assert.strictEqual(splitWorkflowPath(value), undefined);
			}
		});
	});

	describe('normalizeClaims', () => {
		it('derives workflow_path and job_workflow_path', () => {
			const claims = githubActionsProfile.normalizeClaims(GITHUB_CLAIMS);
			assert.strictEqual(claims.workflow_path, 'HarperFast/my-app/.github/workflows/deploy.yml');
			assert.strictEqual(claims.job_workflow_path, 'HarperFast/my-app/.github/workflows/deploy.yml');
		});

		it('preserves the original claims and does not mutate the input', () => {
			const payload = { ...GITHUB_CLAIMS };
			const claims = githubActionsProfile.normalizeClaims(payload);
			assert.strictEqual(claims.repository_id, '67890');
			assert.strictEqual(claims.workflow_ref, WORKFLOW_REF);
			assert.strictEqual(payload.workflow_path, undefined);
		});

		it('omits a derived claim when the reference is not ref-qualified', () => {
			const claims = githubActionsProfile.normalizeClaims({ workflow_ref: 'owner/repo/.github/workflows/x.yml' });
			assert.strictEqual(claims.workflow_path, undefined);
		});

		// An issuer that one day emits workflow_path itself must win over our derivation.
		it('does not displace a claim the token already carries', () => {
			const claims = githubActionsProfile.normalizeClaims({
				workflow_ref: WORKFLOW_REF,
				workflow_path: 'issuer-supplied',
			});
			assert.strictEqual(claims.workflow_path, 'issuer-supplied');
		});
	});

	describe('assertPolicyIsSpecific', () => {
		it('accepts a repository pin plus a ref-qualified workflow pin', () => {
			assert.doesNotThrow(() => githubActionsProfile.assertPolicyIsSpecific({ ...VALID_POLICY_CLAIMS }));
		});

		it('accepts a workflow path gated by an environment', () => {
			assert.doesNotThrow(() =>
				githubActionsProfile.assertPolicyIsSpecific({
					repository_id: '67890',
					workflow_path: 'HarperFast/my-app/.github/workflows/release.yml',
					environment: 'production',
				})
			);
		});

		// repository_owner identifies an org, not a repository — it would admit every repo in the org.
		it('rejects a policy with no repository pin', () => {
			assert.throws(
				() =>
					githubActionsProfile.assertPolicyIsSpecific({ repository_owner: 'HarperFast', workflow_ref: WORKFLOW_REF }),
				/pin the repository/
			);
		});

		it('rejects a policy with no workflow pin', () => {
			assert.throws(
				() => githubActionsProfile.assertPolicyIsSpecific({ repository_id: '67890', environment: 'production' }),
				/pin the workflow/
			);
		});

		// The npm-style "repository + workflow filename" policy: any branch that can be pushed can run
		// the workflow and mint a token.
		it('rejects a workflow pin with no ref gate', () => {
			assert.throws(
				() =>
					githubActionsProfile.assertPolicyIsSpecific({
						repository_id: '67890',
						workflow_path: 'HarperFast/my-app/.github/workflows/deploy.yml',
					}),
				/gate the ref/
			);
		});

		it('does not accept ref_type alone as a ref gate', () => {
			assert.throws(
				() =>
					githubActionsProfile.assertPolicyIsSpecific({
						repository_id: '67890',
						workflow_path: 'HarperFast/my-app/.github/workflows/release.yml',
						ref_type: 'tag',
					}),
				/gate the ref/
			);
		});

		// GitHub's sub varies by trigger and changed format for repos created after 2026-07-15, so it
		// is not one of the accepted pins — unlike the generic profile, which requires it.
		it('does not accept sub as a repository pin', () => {
			assert.throws(
				() => githubActionsProfile.assertPolicyIsSpecific({ sub: GITHUB_CLAIMS.sub, workflow_ref: WORKFLOW_REF }),
				/pin the repository/
			);
		});
	});

	describe('assertAudienceIsSpecific', () => {
		it('rejects the shared org-wide default', () => {
			for (const audience of ['https://github.com/HarperFast', 'https://github.com/HarperFast/']) {
				assert.throws(() => githubActionsProfile.assertAudienceIsSpecific(audience), /must identify this instance/);
			}
		});

		it('accepts an instance URL', () => {
			assert.doesNotThrow(() => githubActionsProfile.assertAudienceIsSpecific('https://my-instance.harperdb.io:9925/'));
		});
	});

	// A pull_request_target run executes the base repo's workflow with its secrets while a fork
	// controls the code, so it is denied unless a policy opts in by constraining event_name.
	describe('vetoClaims', () => {
		it('denies pull_request_target when the policy does not constrain event_name', () => {
			const reason = githubActionsProfile.vetoClaims(
				{ ...GITHUB_CLAIMS, event_name: 'pull_request_target' },
				VALID_POLICY_CLAIMS
			);
			assert.ok(reason);
			assert.match(reason, /pull_request_target/);
		});

		it('allows pull_request_target when the policy opts in', () => {
			const reason = githubActionsProfile.vetoClaims(
				{ ...GITHUB_CLAIMS, event_name: 'pull_request_target' },
				{ ...VALID_POLICY_CLAIMS, event_name: 'pull_request_target' }
			);
			assert.strictEqual(reason, undefined);
		});

		it('leaves ordinary events alone', () => {
			assert.strictEqual(githubActionsProfile.vetoClaims(GITHUB_CLAIMS, VALID_POLICY_CLAIMS), undefined);
		});
	});

	describe('describePrincipal', () => {
		it('names the repository, workflow, environment, run, and actor', () => {
			const described = githubActionsProfile.describePrincipal(GITHUB_CLAIMS);
			for (const fragment of ['HarperFast/my-app', WORKFLOW_REF, 'environment=production', 'run=99', 'actor=octocat']) {
				assert.ok(described.includes(fragment), `expected "${fragment}" in "${described}"`);
			}
		});

		it('tolerates a sparse token', () => {
			assert.strictEqual(typeof githubActionsProfile.describePrincipal({}), 'string');
		});
	});
});
