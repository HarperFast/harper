'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	componentGrantError,
	componentGrantOf,
	componentGrantConstraintRefusal,
	componentGrantPreviewRefusal,
	grantCoversComponent,
	previewCapOf,
	previewExpiryBound,
} = require('#src/security/componentGrant');
const { componentNameMatches } = require('#src/utility/componentNames');
const op_auth = require('#src/utility/operation_authorization');
const operations = require('#js/components/operations');
const deploymentOperations = require('#src/components/deploymentOperations');
const { canRoleInvokeOperation } = require('#src/components/mcp/operationVisibility');
const { addRoleValidation } = require('#src/validation/role_validation');

const previewGrant = {
	names: ['shop-pr-*'],
	constraints: { isolated: true, hostSuffix: '.app.example.com', branchedDatabases: 'required' },
};
const previewUser = (grant = previewGrant, extra = {}) => ({
	username: 'shop-preview',
	role: { role: 'shop-preview', permission: { super_user: false, component_deploy: grant, ...extra } },
});

describe('component grants (harper#3046)', () => {
	describe('name patterns', () => {
		it('match a prefix followed by one or more characters, or an exact name', () => {
			assert.ok(componentNameMatches('shop-pr-*', 'shop-pr-12'));
			assert.ok(!componentNameMatches('shop-pr-*', 'shop-pr-'));
			assert.ok(!componentNameMatches('shop-pr-*', 'shop'));
			assert.ok(!componentNameMatches('shop-pr-*', 'my-shop-pr-12'));
			assert.ok(componentNameMatches('shop-staging', 'shop-staging'));
			assert.ok(!componentNameMatches('shop-staging', 'shop-staging-2'));
		});

		it('cover nothing when malformed, or for a name a deploy would refuse', () => {
			for (const pattern of ['*', 'shop*pr', 'shop-**', '', 42]) assert.ok(!componentNameMatches(pattern, 'shop'));
			assert.ok(!componentNameMatches('shop-pr-*', 'shop-pr-1.2'));
		});
	});

	describe('validation', () => {
		it('accepts names with optional constraints', () => {
			assert.strictEqual(componentGrantError(previewGrant), null);
			assert.strictEqual(componentGrantError({ names: ['shop-pr-*'] }), null);
		});

		for (const [description, grant, message] of [
			['a non-object', ['shop-pr-*'], /must be an object/],
			['no names', { names: [] }, /non-empty array/],
			['a bare wildcard', { names: ['*'] }, /not a component name/],
			['an unknown key', { names: ['a'], deploy: ['a'] }, /unknown key 'deploy'/],
			['an unknown constraint', { names: ['a'], constraints: { urlPath: '/x' } }, /unknown key 'urlPath'/],
			['isolated: false', { names: ['a'], constraints: { isolated: false } }, /can only be true/],
			[
				'a host suffix without a leading dot',
				{ names: ['a'], constraints: { hostSuffix: 'example.com' } },
				/beginning with '\.'/,
			],
			[
				'an unknown branchedDatabases value',
				{ names: ['a'], constraints: { branchedDatabases: true } },
				/only be 'required'/,
			],
			['an unknown preview value', { names: ['a'], constraints: { preview: true } }, /preview' can only be 'required'/],
			[
				'a maxPreviews that is not a whole number',
				{ names: ['a'], constraints: { preview: 'required', maxPreviews: 1.5 } },
				/whole number of at least 1/,
			],
			[
				'a maxTtlDays that is not positive',
				{ names: ['a'], constraints: { preview: 'required', maxTtlDays: 0 } },
				/positive number of days/,
			],
			[
				'a bound on previews the grant does not require',
				{ names: ['a'], constraints: { maxPreviews: 2 } },
				/need 'preview: required'/,
			],
		]) {
			it(`refuses ${description}`, () => assert.match(componentGrantError(grant) ?? '', message));
		}

		it('is applied by add_role', () => {
			const valid = { role: 'shop-preview', permission: { super_user: false, component_deploy: previewGrant } };
			assert.equal(addRoleValidation(valid), null);
			const invalid = { role: 'shop-preview', permission: { super_user: false, component_deploy: { names: ['*'] } } };
			assert.match(JSON.stringify(addRoleValidation(invalid)), /not a component name/);
		});
	});

	describe('constraints', () => {
		const satisfying = { isolated: true, host: 'pr-12.app.example.com', branchedDatabases: true };

		it('allow a deploy that satisfies every one', () => {
			assert.strictEqual(componentGrantConstraintRefusal(previewGrant, 'shop-pr-12', satisfying), undefined);
			assert.strictEqual(
				componentGrantConstraintRefusal(previewGrant, 'shop-pr-12', { ...satisfying, branchedDatabases: ['data'] }),
				undefined
			);
		});

		it('refuse a deploy that is not isolated, has a host outside the suffix, or forks nothing', () => {
			for (const [routing, message] of [
				[{ ...satisfying, isolated: undefined }, /isolated application/],
				[{ ...satisfying, host: 'shop.example.com' }, /host under '.app.example.com'/],
				[{ ...satisfying, host: 'app.example.com' }, /host under/],
				[{ ...satisfying, host: 'evilapp.example.com' }, /host under/],
				[{ ...satisfying, host: undefined }, /host under/],
				[{ ...satisfying, branchedDatabases: [] }, /branchedDatabases/],
				[{ ...satisfying, branchedDatabases: undefined }, /branchedDatabases/],
			]) {
				assert.match(componentGrantConstraintRefusal(previewGrant, 'shop-pr-12', routing) ?? '', message);
			}
		});
	});

	describe('which requests are made under a grant', () => {
		it('none for a super user, or for a role without one', () => {
			assert.strictEqual(
				componentGrantOf({ role: { permission: { super_user: true, component_deploy: previewGrant } } }),
				undefined
			);
			assert.strictEqual(componentGrantOf({ role: { permission: { super_user: false } } }), undefined);
		});

		it('a malformed one covers nothing', () => {
			const grant = componentGrantOf(previewUser({ names: '*' }));
			assert.ok(grant);
			assert.ok(!grantCoversComponent(grant, 'shop-pr-12'));
		});
	});

	describe('verifyPerms', () => {
		const verify = (operation, handler, body, user = previewUser()) =>
			op_auth.verifyPerms({ operation, hdb_user: user, ...body }, handler.name);

		it('allows deploying and dropping a covered component', () => {
			assert.strictEqual(verify('deploy_component', operations.deployComponent, { project: 'shop-pr-12' }), null);
			assert.strictEqual(verify('deploy_component', operations.deployComponent, { project: 'shop-pr-12.tgz' }), null);
			assert.strictEqual(verify('drop_component', operations.dropComponent, { project: 'shop-pr-12' }), null);
		});

		it('refuses a component the grant does not cover', () => {
			for (const [operation, handler, body] of [
				['deploy_component', operations.deployComponent, { project: 'shop' }],
				['deploy_component', operations.deployComponent, { package: 'npm:shop' }],
				['deploy_component', operations.deployComponent, {}],
				['drop_component', operations.dropComponent, { project: 'shop' }],
			]) {
				const denial = verify(operation, handler, body);
				assert.match(JSON.stringify(denial?.unauthorized_access), /not covered by this role's component grant/);
			}
		});

		it("refuses a deploy carrying replication's own `_deploymentId`, which would skip the constraints", () => {
			const denial = verify('deploy_component', operations.deployComponent, {
				project: 'shop-pr-12',
				_deploymentId: '00000000-0000-4000-8000-000000000000',
			});
			assert.match(JSON.stringify(denial?.unauthorized_access), /'_deploymentId' is set by replication/);
		});

		it('refuses a literal token, which only a super user can seal into a stored credential', () => {
			const denial = verify('deploy_component', operations.deployComponent, {
				project: 'shop-pr-12',
				credentials: [{ host: 'github.com', token: 'ghp_literal' }],
			});
			assert.match(JSON.stringify(denial?.unauthorized_access), /only reference stored credentials/);
			const reference = [{ host: 'github.com', secret: 'deploy.shop-pr-_.git.github.com' }];
			assert.strictEqual(
				verify('deploy_component', operations.deployComponent, { project: 'shop-pr-12', credentials: reference }),
				null
			);
		});

		it('lets the reads through to handlers that answer only for covered components', () => {
			assert.strictEqual(verify('get_components', operations.getComponents, {}), null);
			assert.strictEqual(verify('list_deployments', deploymentOperations.handleListDeployments, {}), null);
			assert.strictEqual(
				verify('get_deployment', deploymentOperations.handleGetDeployment, { deployment_id: 'x' }),
				null
			);
		});

		it('reads the grant only for the operations it covers', () => {
			let reads = 0;
			const counted = {
				get names() {
					reads++;
					return previewGrant.names;
				},
				constraints: previewGrant.constraints,
			};
			verify('add_component', operations.addComponent, { project: 'shop-pr-12' }, previewUser(counted));
			assert.strictEqual(reads, 0, 'an operation outside the grant never reads it');
			verify('drop_component', operations.dropComponent, { project: 'shop-pr-12' }, previewUser(counted));
			assert.ok(reads > 0, 'a covered operation does');
		});

		it('reaches nothing else that is restricted to super users', () => {
			assert.ok(verify('get_component_file', operations.getComponentFile, { project: 'shop-pr-12', file: 'x' }));
			assert.ok(verify('add_component', operations.addComponent, { project: 'shop-pr-12' }));
		});

		it('still answers to its names when an operations allowlist lists the operation', () => {
			const user = previewUser(previewGrant, { operations: ['deploy_component'] });
			assert.ok(verify('deploy_component', operations.deployComponent, { project: 'shop' }, user));
			assert.strictEqual(verify('deploy_component', operations.deployComponent, { project: 'shop-pr-1' }, user), null);
			assert.ok(verify('drop_component', operations.dropComponent, { project: 'shop-pr-1' }, user), 'not listed');
		});

		it('is advertised to MCP discovery for exactly the operations it reaches', () => {
			assert.ok(canRoleInvokeOperation(previewUser(), 'deploy_component'));
			assert.ok(canRoleInvokeOperation(previewUser(), 'get_components'));
			assert.ok(!canRoleInvokeOperation(previewUser(), 'get_component_file'));
		});
	});
	describe('preview constraints (harper#3042)', () => {
		const bounded = {
			names: ['shop-pr-*'],
			constraints: { preview: 'required', maxPreviews: 4, maxTtlDays: 2 },
		};

		it('validate', () => assert.strictEqual(componentGrantError(bounded), null));

		it('require a preview of an application the grant previews, named as that preview', () => {
			assert.strictEqual(componentGrantPreviewRefusal(bounded, 'shop-pr-12', { app: 'shop', pr: 12 }), undefined);
			assert.match(componentGrantPreviewRefusal(bounded, 'shop-pr-12', undefined), /as a PR preview/);
			assert.match(
				componentGrantPreviewRefusal(bounded, 'shop-pr-pr-3', { app: 'shop-pr', pr: 3 }),
				/a preview of an application/
			);
			assert.match(componentGrantPreviewRefusal(bounded, 'shop-pr-12', { app: 'shop', pr: 13 }), /'<app>-pr-<n>'/);
			assert.strictEqual(componentGrantPreviewRefusal(previewGrant, 'shop-pr-tools', undefined), undefined);
		});

		it('bound the expiry and the count', () => {
			assert.strictEqual(previewExpiryBound(bounded, 1000), 1000 + 2 * 24 * 60 * 60 * 1000);
			assert.strictEqual(previewExpiryBound(previewGrant, 1000), undefined);
			assert.strictEqual(previewExpiryBound(undefined, 1000), undefined);
			assert.strictEqual(previewCapOf(bounded), 4);
			assert.strictEqual(previewCapOf(undefined), undefined);
		});
	});
});
