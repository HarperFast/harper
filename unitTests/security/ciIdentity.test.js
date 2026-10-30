'use strict';

const assert = require('node:assert');
const { planIdentityReconcile, policiesOverlap, roleDifference } = require('#src/security/ciIdentity');
const { derivePreviewNames, isPreviewProjectOf, canonicalWorkflowPath } = require('#src/utility/previewIdentity');

const grant = {
	names: ['web-pr-*'],
	constraints: { isolated: true, hostSuffix: '.app.example.com', preview: 'required' },
};
const desiredRole = {
	role: 'web-ci-preview',
	permission: { super_user: false, operations: ['drop_component'], component_deploy: grant },
};
const policy = (id, environment) => ({
	id,
	issuer: 'https://token.actions.githubusercontent.com',
	audience: 'https://cluster.example.com:9925/',
	user: 'web-ci-preview',
	claims: { repository_id: '1', workflow_ref: 'a/web/.github/workflows/preview.yaml@refs/heads/main', environment },
	operations: ['drop_component'],
	description: 'x',
});

describe('ciIdentity', () => {
	describe('roleDifference', () => {
		it('compares a component grant by its names as a set and its constraints exactly', () => {
			const stored = { role: 'web-ci-preview', permission: { ...desiredRole.permission } };
			assert.strictEqual(roleDifference(stored, desiredRole), undefined);
			const widened = {
				...stored,
				permission: { ...stored.permission, component_deploy: { names: ['web-*'], constraints: grant.constraints } },
			};
			assert.match(roleDifference(widened, desiredRole), /component_deploy grant is/);
			const unbounded = { ...stored, permission: { ...stored.permission, component_deploy: { names: ['web-pr-*'] } } };
			assert.match(roleDifference(unbounded, desiredRole), /component_deploy grant is/);
			const { component_deploy: _grant, ...withoutGrant } = stored.permission;
			assert.match(
				roleDifference({ ...stored, permission: withoutGrant }, desiredRole),
				/component_deploy grant is null/
			);
		});

		it("flags a grant on a role whose desired shape has none, the production deploy role's", () => {
			const production = { role: 'web-ci-deploy', permission: { super_user: false, operations: ['deploy_component'] } };
			const stored = { role: 'web-ci-deploy', permission: { ...production.permission, component_deploy: grant } };
			assert.match(roleDifference(stored, production), /component_deploy grant is/);
		});
	});

	it('plans each policy of the identity on its own', () => {
		const plan = planIdentityReconcile(
			{
				roles: [],
				users: [],
				policies: [
					{ ...policy('p1', 'preview'), enabled: true },
					{ ...policy('p2', 'x'), enabled: true },
				],
			},
			{
				role: desiredRole,
				user: { username: 'web-ci-preview', role: 'web-ci-preview' },
				policies: [policy('p1', 'preview'), policy('p2', 'preview-cleanup')],
			},
			(id) => `drop ${id}`
		);
		assert.deepStrictEqual(plan.policies, ['keep', 'keep']);
		assert.strictEqual(plan.conflicts.length, 1);
		assert.match(plan.conflicts[0], /Trust policy "p2" already exists and claim environment is "x".*drop p2$/);
	});

	describe('sameAuthority', () => {
		const { sameAuthority, policyDifferences } = require('#src/security/ciIdentity');
		it('compares the user, and the operations as a set, with no scope apart from every scope', () => {
			assert.ok(sameAuthority({ user: 'a', operations: ['x', 'y'] }, { user: 'a', operations: ['y', 'x', 'y'] }));
			assert.ok(sameAuthority({ user: 'a' }, { user: 'a', operations: null }));
			assert.ok(!sameAuthority({ user: 'a' }, { user: 'a', operations: [] }));
			assert.ok(!sameAuthority({ user: 'a', operations: ['x'] }, { user: 'a', operations: ['x', 'y'] }));
			assert.ok(!sameAuthority({ user: 'a', operations: ['x'] }, { user: 'b', operations: ['x'] }));
		});
		it('lets policyDifferences read reordered or repeated operations as the same', () => {
			const policy = { issuer: 'i', audience: 'a', user: 'u', claims: {}, operations: ['x', 'y'] };
			assert.deepStrictEqual(policyDifferences({ ...policy, operations: ['y', 'x', 'x'] }, policy), []);
		});
	});

	describe('policiesOverlap', () => {
		it('holds when every claim both constrain accepts a common value, scalar or list', () => {
			assert.ok(policiesOverlap(policy('a', 'preview'), policy('b', 'preview')));
			const listed = policy('b', ['staging', 'preview']);
			assert.ok(policiesOverlap(policy('a', 'preview'), listed));
			const { environment: _environment, ...looser } = policy('c', 'x').claims;
			assert.ok(policiesOverlap(policy('a', 'preview'), { ...policy('c', 'x'), claims: looser }));
		});

		it('does not hold across environments, audiences or issuers', () => {
			assert.ok(!policiesOverlap(policy('a', 'preview'), policy('b', 'preview-cleanup')));
			assert.ok(
				!policiesOverlap(policy('a', 'preview'), { ...policy('b', 'preview'), audience: 'https://other:9925/' })
			);
			assert.ok(!policiesOverlap(policy('a', 'preview'), { ...policy('b', 'preview'), issuer: 'https://other' }));
		});
	});

	describe('preview names', () => {
		it('are derived from the application, the shared contract with Studio', () => {
			assert.deepStrictEqual(derivePreviewNames('shop'), {
				role: 'shop-ci-preview',
				user: 'shop-ci-preview',
				policy: 'github-actions-shop-preview',
				cleanupPolicy: 'github-actions-shop-preview-cleanup',
				components: 'shop-pr-*',
			});
			assert.throws(() => derivePreviewNames('has space'), /must be a component name/);
			assert.throws(() => derivePreviewNames('x'.repeat(110)), /not a valid trust policy id/);
		});

		it('recognize only `<app>-pr-<n>` as a preview of the application', () => {
			assert.ok(isPreviewProjectOf('shop', 'shop-pr-12'));
			assert.ok(isPreviewProjectOf('shop', 'shop-pr-12', 12));
			assert.ok(!isPreviewProjectOf('shop', 'shop-pr-12', 13));
			for (const project of ['shop-pr-tools', 'shop-pr-pr-3', 'shop-pr-0', 'shop-pr-012', 'shop-pr-', 'shop']) {
				assert.ok(!isPreviewProjectOf('shop', project), project);
			}
		});

		it('name the workflow as GitHub does in workflow_ref', () => {
			assert.strictEqual(canonicalWorkflowPath('./.github/workflows/preview.yaml'), '.github/workflows/preview.yaml');
		});
	});
});
