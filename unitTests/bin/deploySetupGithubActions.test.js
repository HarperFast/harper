'use strict';

// `harper deploy setup=true provider=github-actions` writes a trust policy that must match, claim for
// claim, the token a GitHub Actions run presents; a mismatch only ever shows up as a bare 401 in CI.
// These cases cover the derivations and the create-missing-only reconcile. The end-to-end run against
// a real Harper is integrationTests/security/deploy-setup-github-actions.test.ts.
const assert = require('node:assert');
const {
	buildWorkflowRef,
	canonicalWorkflowPath,
	checkWorkflowFile,
	deriveCiNames,
	planReconcile,
	policyDifferences,
	rawStringArg,
	roleDifference,
	userDifference,
	CI_DEPLOY_OPERATIONS,
	GITHUB_ACTIONS_ISSUER,
} = require('#src/bin/deploySetupGithubActions');
const { buildRequest } = require('#src/bin/cliOperations');

const desired = () => ({
	role: { role: 'web-ci-deploy', permission: { super_user: false, operations: [...CI_DEPLOY_OPERATIONS] } },
	user: { username: 'web-ci-deploy', role: 'web-ci-deploy' },
	policy: {
		id: 'github-actions-web',
		issuer: GITHUB_ACTIONS_ISSUER,
		audience: 'https://cluster.example.com:9925/',
		user: 'web-ci-deploy',
		claims: {
			repository_id: '67890',
			workflow_ref: 'acme/web/.github/workflows/deploy.yaml@refs/heads/main',
			environment: 'production',
		},
		operations: [...CI_DEPLOY_OPERATIONS],
		description: 'GitHub Actions deploys of web',
	},
});

const matchingRole = () => ({ id: 'web-ci-deploy', role: 'web-ci-deploy', permission: desired().role.permission });
const matchingUser = () => ({ username: 'web-ci-deploy', active: true, role: { role: 'web-ci-deploy' } });
const matchingPolicy = () => ({ ...desired().policy, enabled: true });

describe('deploySetupGithubActions', () => {
	describe('deriveCiNames', () => {
		it('names the role, user and policy after the component, so projects can share a cluster', () => {
			assert.deepStrictEqual(deriveCiNames('web'), {
				role: 'web-ci-deploy',
				user: 'web-ci-deploy',
				policy: 'github-actions-web',
			});
		});

		it('refuses a policy id add_oidc_trust would reject, before anything is written', () => {
			assert.throws(() => deriveCiNames('x'.repeat(120)), /not a valid trust policy id/);
		});
	});

	describe('buildWorkflowRef', () => {
		it("matches GitHub's workflow_ref claim: owner/repo/path@refs/heads/branch", () => {
			assert.strictEqual(
				buildWorkflowRef('acme/web', '.github/workflows/deploy.yaml', 'main'),
				'acme/web/.github/workflows/deploy.yaml@refs/heads/main'
			);
		});
	});

	describe('canonicalWorkflowPath', () => {
		// The file check and the claim must name the same path, spelled as GitHub spells it.
		it('normalizes the spellings that name the same file', () => {
			for (const spelling of [
				'.github/workflows/deploy.yaml',
				'./.github/workflows/deploy.yaml',
				'.github/workflows/./deploy.yaml',
				'.github/workflows/../workflows/deploy.yaml',
			]) {
				assert.strictEqual(canonicalWorkflowPath(spelling), '.github/workflows/deploy.yaml');
			}
		});

		it('refuses a path GitHub would never run a workflow from', () => {
			for (const path of [
				'/Users/me/app/.github/workflows/deploy.yaml',
				'deploy.yaml',
				'.github/workflows/ci/deploy.yaml',
			]) {
				assert.throws(() => canonicalWorkflowPath(path), /must name a file in \.github\/workflows\//);
			}
		});
	});

	describe('rawStringArg', () => {
		let savedArgv;
		beforeEach(() => {
			savedArgv = process.argv;
		});
		afterEach(() => {
			process.argv = savedArgv;
		});

		// buildRequest JSON-parses every value, so a branch named "1.0" would otherwise pin "1".
		it('keeps a numeric-looking branch as typed', () => {
			process.argv = ['node', 'harper', 'deploy', 'setup=true', 'branch=1.0', 'repository_id=00123'];
			const req = buildRequest();
			assert.strictEqual(req.branch, 1);
			assert.strictEqual(rawStringArg(req, 'branch'), '1.0');
			assert.strictEqual(rawStringArg(req, 'repository_id'), '00123');
		});

		it('keeps the raw values out of the request body and any serialization', () => {
			process.argv = ['node', 'harper', 'deploy', 'auth_password=s3cret', 'branch=main'];
			const req = buildRequest();
			assert.ok(!Object.keys(req).includes('_rawArgs'));
			// Only the parsed fields, so the raw copy adds no second place a credential can leak from.
			assert.deepStrictEqual(JSON.parse(JSON.stringify(req)), {
				operation: 'deploy_component',
				auth_password: 's3cret',
				branch: 'main',
			});
		});

		it('falls back to the parsed value for a hand-built request', () => {
			assert.strictEqual(rawStringArg({ branch: 'main' }, 'branch'), 'main');
			assert.strictEqual(rawStringArg({}, 'branch'), undefined);
		});
	});

	describe('checkWorkflowFile', () => {
		const workflow = (branches, environment) => `
on:
  push:
    branches: ${JSON.stringify(branches)}
jobs:
  test:
    runs-on: ubuntu-latest
  deploy:
    runs-on: ubuntu-latest
    environment: ${JSON.stringify(environment)}
`;

		it('accepts a workflow that deploys from the branch, in the environment', () => {
			assert.deepStrictEqual(checkWorkflowFile(workflow(['main'], 'production'), 'main', 'production'), {
				problems: [],
				unverified: [],
			});
		});

		it('refuses a branch the workflow never deploys from', () => {
			const { problems } = checkWorkflowFile(workflow(['release'], 'production'), 'main', 'production');
			assert.match(problems[0], /pushes to release, not "main"/);
		});

		// GitHub matches on.push.branches as globs; setup must not refuse a pattern it can't evaluate.
		it('reports a branch pattern as unverified rather than a mismatch', () => {
			const { problems, unverified } = checkWorkflowFile(workflow(['**'], 'production'), 'main', 'production');
			assert.deepStrictEqual(problems, []);
			assert.match(unverified[0], /that \*\* matches "main"/);
		});

		it("treats GitHub's + quantifier as a pattern", () => {
			const { problems, unverified } = checkWorkflowFile(workflow(['mai+n'], 'production'), 'main', 'production');
			assert.deepStrictEqual(problems, []);
			assert.strictEqual(unverified.length, 1);
		});

		// A manual run can still deploy from the branch the push filter leaves out.
		it('reports a branch only workflow_dispatch can reach as unverified', () => {
			const content =
				'on:\n  push:\n    branches: [release]\n  workflow_dispatch:\njobs:\n  deploy:\n    environment: production\n';
			const { problems, unverified } = checkWorkflowFile(content, 'main', 'production');
			assert.deepStrictEqual(problems, []);
			assert.match(unverified[0], /only workflow_dispatch can run it there/);
		});

		it('reports a branch a scheduled or dispatched run can reach as unverified', () => {
			const content =
				'on:\n  push:\n    branches: [release]\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  deploy:\n    environment: production\n';
			const { problems, unverified } = checkWorkflowFile(content, 'main', 'production');
			assert.deepStrictEqual(problems, []);
			assert.match(unverified[0], /only schedule can run it there/);
		});

		// GitHub leaves the environment claim out of a token for a job with none.
		it('refuses a workflow in which no job sets an environment', () => {
			const content = 'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n';
			assert.match(checkWorkflowFile(content, 'main', 'production').problems[0], /no job sets an environment/);
		});

		it('cannot tell the environment of a job that calls a reusable workflow', () => {
			const content =
				'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    uses: ./.github/workflows/release.yaml\n';
			const { problems, unverified } = checkWorkflowFile(content, 'main', 'production');
			assert.deepStrictEqual(problems, []);
			assert.match(unverified[0], /"production" environment/);
		});

		it('refuses an environment no job runs in', () => {
			const { problems } = checkWorkflowFile(workflow(['main'], 'staging'), 'main', 'production');
			assert.match(problems[0], /environment staging, not "production"/);
		});

		it('reads an environment given as { name }', () => {
			const content =
				'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    environment:\n      name: production\n';
			assert.deepStrictEqual(checkWorkflowFile(content, 'main', 'production').problems, []);
		});

		// An expression is resolved at run time, so it can't be checked here; it must not read as a match.
		it('reports expressions and missing filters as unverified, not as a match', () => {
			const content = 'on: [push]\njobs:\n  deploy:\n    environment: ${{ inputs.env }}\n';
			const { problems, unverified } = checkWorkflowFile(content, 'main', 'production');
			assert.deepStrictEqual(problems, []);
			assert.strictEqual(unverified.length, 2);
		});

		it('reports a file it cannot parse', () => {
			assert.match(checkWorkflowFile('on: [', 'main', 'production').problems[0], /not valid YAML/);
		});
	});

	describe('roleDifference / userDifference / policyDifferences', () => {
		it('accepts records exactly as setup would create them', () => {
			assert.strictEqual(roleDifference(matchingRole(), desired().role), undefined);
			assert.strictEqual(userDifference(matchingUser(), desired().user), undefined);
			assert.deepStrictEqual(policyDifferences(matchingPolicy(), desired().policy), []);
		});

		it('treats operation lists as sets', () => {
			const role = matchingRole();
			role.permission = { ...role.permission, operations: ['get_job', 'deploy_component'] };
			assert.strictEqual(roleDifference(role, desired().role), undefined);
		});

		it('flags a role with more authority than deploying', () => {
			const role = matchingRole();
			assert.match(roleDifference({ ...role, permission: { super_user: true } }, desired().role), /super_user/);
			assert.match(
				roleDifference({ ...role, permission: { ...role.permission, data: { tables: {} } } }, desired().role),
				/database permissions \(data\)/
			);
			assert.match(
				roleDifference(
					{ ...role, permission: { ...role.permission, operations: ['deploy_component', 'get_job', 'add_user'] } },
					desired().role
				),
				/its operations are/
			);
		});

		it('flags a role that sets structure_user or cluster_user', () => {
			const role = matchingRole();
			for (const flag of ['structure_user', 'cluster_user']) {
				assert.strictEqual(
					roleDifference({ ...role, permission: { ...role.permission, [flag]: true } }, desired().role),
					`it sets ${flag}`
				);
			}
		});

		it('flags a user in another role, or one someone deactivated', () => {
			assert.match(userDifference({ ...matchingUser(), role: { role: 'other' } }, desired().user), /in role "other"/);
			assert.match(userDifference({ ...matchingUser(), active: false }, desired().user), /inactive/);
		});

		it('names every claim that differs, including one only the stored policy has', () => {
			const stored = matchingPolicy();
			stored.claims = { ...stored.claims, environment: 'staging', ref: 'refs/heads/main' };
			const differences = policyDifferences(stored, desired().policy);
			assert.ok(differences.some((line) => /claim environment is "staging"/.test(line)));
			assert.ok(differences.some((line) => /claim ref is "refs\/heads\/main"/.test(line)));
		});

		it('flags a disabled policy, so setup cannot quietly undo a revocation', () => {
			assert.deepStrictEqual(policyDifferences({ ...matchingPolicy(), enabled: false }, desired().policy), [
				'it is disabled',
			]);
		});
	});

	describe('planReconcile', () => {
		it('creates everything on an empty cluster', () => {
			assert.deepStrictEqual(planReconcile({ roles: [], users: [], policies: [] }, desired()), {
				role: 'create',
				user: 'create',
				policy: 'create',
				conflicts: [],
			});
		});

		it('leaves records that already match, so a rerun changes nothing', () => {
			const plan = planReconcile(
				{ roles: [matchingRole()], users: [matchingUser()], policies: [matchingPolicy()] },
				desired()
			);
			assert.deepStrictEqual(plan, { role: 'keep', user: 'keep', policy: 'keep', conflicts: [] });
		});

		it('finishes a partial setup: creates only what is missing', () => {
			const plan = planReconcile({ roles: [matchingRole()], users: [], policies: [] }, desired());
			assert.deepStrictEqual(plan, { role: 'keep', user: 'create', policy: 'create', conflicts: [] });
		});

		it('refuses every conflict at once, and says how to replace a policy', () => {
			const plan = planReconcile(
				{
					roles: [{ ...matchingRole(), permission: { super_user: true } }],
					users: [{ ...matchingUser(), active: false }],
					policies: [{ ...matchingPolicy(), audience: 'https://other.example.com:9925/' }],
				},
				desired()
			);
			assert.strictEqual(plan.conflicts.length, 3);
			assert.match(plan.conflicts[2], /harper drop_oidc_trust id=github-actions-web/);
		});
	});
});
