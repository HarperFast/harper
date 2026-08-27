'use strict';

// Op-flow tests for the hdb_oidc_trust operations, following the secretOperations.test.js pattern:
// a Map-backed mock table on databases.system plus a seeded users cache, so the real handlers run
// without stubs.

const assert = require('node:assert');
const testUtils = require('../../../testUtils.js');
testUtils.preTestPrep();

const {
	addOidcTrust,
	listOidcTrust,
	dropOidcTrust,
	loadEnabledPolicies,
} = require('#src/security/authn/oidc/trustPolicyOperations');
const { databases } = require('#src/resources/databases');
const { setUsersWithRolesCache } = require('#src/security/user');
const terms = require('#src/utility/hdbTerms');
const opAuth = require('#src/utility/operation_authorization');

const OIDC_TRUST_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TRUST_TABLE_NAME;
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'https://my-instance.harperdb.io:9925/';

const VALID_CLAIMS = {
	repository_id: '67890',
	workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main',
};

function installMockTable() {
	const rows = new Map();
	const mock = {
		rows,
		async get(id) {
			return rows.get(id);
		},
		async put(row) {
			rows.set(row.id, row);
		},
		async delete(id) {
			return rows.delete(id);
		},
		search() {
			return (async function* () {
				yield* rows.values();
			})();
		},
	};
	if (!databases.system) databases.system = {};
	const prior = databases.system[OIDC_TRUST_TABLE];
	databases.system[OIDC_TRUST_TABLE] = mock;
	return {
		mock,
		restore() {
			if (databases.system) databases.system[OIDC_TRUST_TABLE] = prior;
		},
	};
}

function seedUsers() {
	const users = new Map();
	users.set('ci-deploy', {
		username: 'ci-deploy',
		active: true,
		role: { role: 'deployer', permission: { super_user: false } },
	});
	users.set('admin', { username: 'admin', active: true, role: { role: 'su', permission: { super_user: true } } });
	users.set('retired', { username: 'retired', active: false, role: { role: 'deployer', permission: {} } });
	return setUsersWithRolesCache(users);
}

const su = (op, body = {}) => ({
	operation: op,
	hdb_user: { username: 'admin', role: { permission: { super_user: true } } },
	...body,
});
// A role whose `operations` allowlist names the op: the in-handler check must still refuse.
const delegated = (op, body = {}) => ({
	operation: op,
	hdb_user: { username: 'joe', role: { permission: { super_user: false, operations: [op] } } },
	...body,
});

function validPolicy(overrides = {}) {
	return {
		id: 'my-app-prod',
		issuer: ISSUER,
		audience: AUDIENCE,
		claims: { ...VALID_CLAIMS },
		user: 'ci-deploy',
		...overrides,
	};
}

describe('oidc trustPolicyOperations', () => {
	let installed;

	beforeEach(async () => {
		installed = installMockTable();
		await seedUsers();
	});

	afterEach(() => {
		installed.restore();
	});

	describe('super_user enforcement (in-handler, allowlist-proof)', () => {
		const cases = [
			['add_oidc_trust', addOidcTrust, validPolicy()],
			['list_oidc_trust', listOidcTrust, {}],
			['drop_oidc_trust', dropOidcTrust, { id: 'my-app-prod' }],
		];
		for (const [name, handler, body] of cases) {
			it(`${name} refuses a non-super_user even when the role allowlists it`, async () => {
				await assert.rejects(() => handler(delegated(name, body)), /restricted to super_user/);
			});
		}
	});

	describe('addOidcTrust', () => {
		it('stores a policy', async () => {
			const result = await addOidcTrust(su('add_oidc_trust', validPolicy()));
			assert.match(result.message, /my-app-prod/);
			assert.strictEqual(result.warning, undefined);

			const stored = installed.mock.rows.get('my-app-prod');
			assert.strictEqual(stored.issuer, ISSUER);
			assert.strictEqual(stored.user, 'ci-deploy');
			assert.strictEqual(stored.enabled, true);
			assert.strictEqual(stored.updated_by, 'admin');
			assert.deepStrictEqual(stored.claims, VALID_CLAIMS);
		});

		it('normalizes the issuer so one issuer is one spelling', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ issuer: ISSUER + '/' })));
			assert.strictEqual(installed.mock.rows.get('my-app-prod').issuer, ISSUER);
		});

		it('replaces rather than merges, so a narrowed claim set actually narrows', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ claims: { ...VALID_CLAIMS, environment: 'staging' } })));
			await addOidcTrust(su('add_oidc_trust', validPolicy()));
			assert.deepStrictEqual(installed.mock.rows.get('my-app-prod').claims, VALID_CLAIMS);
		});

		// The default GitHub audience is shared by every repo under an owner; accepting it would make a
		// token minted by any of them valid here.
		it('rejects an issuer default audience', async () => {
			for (const audience of ['https://github.com/HarperFast', 'https://github.com/HarperFast/']) {
				await assert.rejects(
					() => addOidcTrust(su('add_oidc_trust', validPolicy({ audience }))),
					/must identify this instance/
				);
			}
		});

		// The audience is compared byte-for-byte at verification time against what the CLI requested,
		// and the CLI requests normalizeTarget(target) — port and trailing slash included. A policy
		// written the natural way would therefore never match, and the exchange says only "rejected",
		// so the operator learns nothing. It has to fail here, at write time, instead.
		// `enabled` is a revocation control, so it has to fail closed. Joi coerces by default and
		// validateBySchema keeps only `result.error`, discarding the converted value — so without
		// `.strict()` the string "false" validated cleanly, survived as a string, and `!== false` read
		// it as enabled. An operator disabling a policy this way would get no error and a policy that
		// kept minting tokens.
		it('rejects a non-boolean enabled rather than coercing it', async () => {
			for (const enabled of ['false', 'true', 0, 1]) {
				await assert.rejects(
					() => addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'coerce-me', enabled }))),
					`expected ${JSON.stringify(enabled)} to be refused rather than coerced`
				);
			}
		});

		it('stores a genuinely disabled policy as disabled', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'off', enabled: false })));
			assert.strictEqual(installed.mock.rows.get('off').enabled, false);
		});

		it('rejects an audience missing the port or the trailing slash', async () => {
			for (const audience of [
				'https://my-instance.harperdb.io',
				'https://my-instance.harperdb.io/',
				'https://my-instance.harperdb.io:9925',
			]) {
				await assert.rejects(
					() => addOidcTrust(su('add_oidc_trust', validPolicy({ audience }))),
					/byte-for-byte/,
					`expected '${audience}' to be refused as non-canonical`
				);
			}
		});

		// Pins this check to the CLI's actual normalization rather than to my reading of it: whatever
		// normalizeTarget produces must be accepted here, or the two drift and the feature breaks in
		// the one place nobody is watching.
		it('accepts every shape normalizeTarget produces', async () => {
			const { normalizeTarget } = require('#src/bin/cliCredentials');
			for (const raw of [
				'my-instance.harperdb.io',
				'https://my-instance.harperdb.io',
				'https://my-instance.harperdb.io:443',
				'http://localhost:9925',
			]) {
				const audience = normalizeTarget(raw);
				await assert.doesNotReject(
					() => addOidcTrust(su('add_oidc_trust', validPolicy({ audience }))),
					`normalizeTarget('${raw}') => '${audience}' must be a writable audience`
				);
			}
		});

		it('rejects a non-https issuer', async () => {
			await assert.rejects(
				() => addOidcTrust(su('add_oidc_trust', validPolicy({ issuer: 'http://token.actions.githubusercontent.com' }))),
				/https/
			);
		});

		// Delegated to validateTrustPolicyClaims, which has its own coverage; this asserts the handler
		// actually calls it rather than storing whatever it is given.
		it('rejects an over-broad claim set', async () => {
			await assert.rejects(
				() => addOidcTrust(su('add_oidc_trust', validPolicy({ claims: { repository_id: '67890' } }))),
				/pin the workflow/
			);
			assert.strictEqual(installed.mock.rows.size, 0, 'expected nothing stored');
		});

		it('rejects a policy naming a user that does not exist', async () => {
			await assert.rejects(
				() => addOidcTrust(su('add_oidc_trust', validPolicy({ user: 'ghost' }))),
				/No such user 'ghost'/
			);
		});

		it('rejects a policy naming an inactive user', async () => {
			await assert.rejects(() => addOidcTrust(su('add_oidc_trust', validPolicy({ user: 'retired' }))), /inactive/);
		});

		it('warns when the policy hands a workflow super_user', async () => {
			const result = await addOidcTrust(su('add_oidc_trust', validPolicy({ user: 'admin' })));
			assert.match(result.warning, /super_user/);
			// Still stored — an admin may mean it; it just should not be silent.
			assert.strictEqual(installed.mock.rows.get('my-app-prod').user, 'admin');
		});

		it('stores an operation scope', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ operations: ['deploy_component'] })));
			assert.deepStrictEqual(installed.mock.rows.get('my-app-prod').operations, ['deploy_component']);
		});

		it('accepts an operation group', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ operations: ['read_only'] })));
			assert.deepStrictEqual(installed.mock.rows.get('my-app-prod').operations, ['read_only']);
		});

		// A typo would otherwise fail closed at request time, in CI, with nothing to point at.
		it('rejects an operation name that is not a Harper operation', async () => {
			await assert.rejects(
				() => addOidcTrust(su('add_oidc_trust', validPolicy({ operations: ['deploy_compnent'] }))),
				/not a Harper operation/
			);
			assert.strictEqual(installed.mock.rows.size, 0, 'expected nothing stored');
		});

		// Asserts the delegation to validateOperations, not the worker→main topology: registering here
		// puts the mark in this thread's own registry, so a same-thread test cannot distinguish the two.
		// The cross-thread path a real component takes is covered in
		// integrationTests/components/registered-operation.test.ts.
		it('accepts an operation registered in this process', async () => {
			const dynamicOp = 'test_dynamic_scope_op';
			opAuth.registerOperationPermission(dynamicOp, { requiresSu: true });
			try {
				await addOidcTrust(su('add_oidc_trust', validPolicy({ operations: [dynamicOp] })));
				assert.deepStrictEqual(installed.mock.rows.get('my-app-prod').operations, [dynamicOp]);
			} finally {
				opAuth.unregisterOperationPermission(dynamicOp);
			}
		});

		it('leaves operations null when the policy does not scope', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy()));
			assert.strictEqual(installed.mock.rows.get('my-app-prod').operations, null);
		});

		it('rejects a malformed id', async () => {
			for (const id of ['', 'has spaces', 'has/slash', 'x'.repeat(129)]) {
				await assert.rejects(() => addOidcTrust(su('add_oidc_trust', validPolicy({ id }))));
			}
		});
	});

	// A row the exchange refuses must not list as healthy. The failure mode this guards: the row
	// arrives by replication or a restore, every exchange returns the deliberately opaque 401, and
	// list_oidc_trust — the one command an operator runs to check — tells them the trust is enabled.
	describe('listing an unusable stored policy', () => {
		it('reports why a refused policy is dead instead of showing it as healthy', async () => {
			installed.mock.rows.set('broken', {
				id: 'broken',
				issuer: ISSUER,
				audience: AUDIENCE,
				claims: { ...VALID_CLAIMS },
				user: 'ci-deploy',
				enabled: 'false',
			});

			const listed = (await listOidcTrust(su('list_oidc_trust'))).policies.find((policy) => policy.id === 'broken');
			assert.ok(listed, 'the row must still be listed — a listing tells the truth about what is stored');
			assert.notStrictEqual(listed.enabled, true, "'false' must not be reported as enabled: true");
			assert.match(listed.invalid_reason, /enabled/, 'expected the listing to say why it is refused');
		});

		// The exchange also refuses a well-formed row whose user has been deleted or deactivated, with
		// the same opaque 401 — and that is the most mundane arrival of all: someone removes the CI
		// user and every deploy starts failing while the listing still says the trust is fine.
		it('reports a policy naming a user that no longer exists', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'gone' })));
			await setUsersWithRolesCache(new Map());

			const listed = (await listOidcTrust(su('list_oidc_trust'))).policies.find((p) => p.id === 'gone');
			assert.match(listed.invalid_reason, /does not exist/);
		});

		it('reports a policy naming a deactivated user', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'inactive' })));
			const users = new Map();
			users.set('ci-deploy', { username: 'ci-deploy', active: false, role: { role: 'r', permission: {} } });
			await setUsersWithRolesCache(users);

			const listed = (await listOidcTrust(su('list_oidc_trust'))).policies.find((p) => p.id === 'inactive');
			assert.match(listed.invalid_reason, /inactive/);
		});

		// Precedence: when a row is both malformed AND names a missing user, the shape problem is the
		// one reported. It is the more fundamental complaint — the row would be refused even if the
		// user were restored — and without this case the `continue` implementing it can be mutated to
		// a no-op with every test still green.
		it('reports the shape problem, not the user, when a row has both', async () => {
			installed.mock.rows.set('both', {
				id: 'both',
				issuer: ISSUER,
				audience: AUDIENCE,
				claims: { ...VALID_CLAIMS },
				user: 'ghost-user',
				operations: 'deploy_component',
			});

			const listed = (await listOidcTrust(su('list_oidc_trust'))).policies.find((p) => p.id === 'both');
			assert.match(listed.invalid_reason, /operations/, 'the shape problem is the more fundamental one');
			assert.doesNotMatch(listed.invalid_reason, /ghost-user/);
		});

		it('leaves a well-formed policy unannotated', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy()));
			const listed = (await listOidcTrust(su('list_oidc_trust'))).policies.find(
				(policy) => policy.id === 'my-app-prod'
			);
			assert.strictEqual(listed.enabled, true);
			assert.strictEqual(listed.invalid_reason, undefined);
		});
	});

	describe('listOidcTrust', () => {
		it('returns policies sorted by id', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'zulu' })));
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'alpha' })));
			const { policies } = await listOidcTrust(su('list_oidc_trust'));
			assert.deepStrictEqual(
				policies.map((policy) => policy.id),
				['alpha', 'zulu']
			);
		});

		it('includes disabled policies', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ enabled: false })));
			const { policies } = await listOidcTrust(su('list_oidc_trust'));
			assert.strictEqual(policies.length, 1);
			assert.strictEqual(policies[0].enabled, false);
		});
	});

	describe('dropOidcTrust', () => {
		it('removes a policy', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy()));
			const result = await dropOidcTrust(su('drop_oidc_trust', { id: 'my-app-prod' }));
			assert.match(result.message, /my-app-prod/);
			assert.strictEqual(installed.mock.rows.size, 0);
		});

		it('reports a missing policy as not found', async () => {
			await assert.rejects(
				() => dropOidcTrust(su('drop_oidc_trust', { id: 'never-existed' })),
				(error) => {
					assert.strictEqual(error.statusCode, 404);
					return true;
				}
			);
		});
	});

	describe('loadEnabledPolicies', () => {
		it('skips disabled policies and sorts by id', async () => {
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'zulu' })));
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'alpha' })));
			await addOidcTrust(su('add_oidc_trust', validPolicy({ id: 'disabled', enabled: false })));
			const policies = await loadEnabledPolicies();
			assert.deepStrictEqual(
				policies.map((policy) => policy.id),
				['alpha', 'zulu']
			);
		});
	});
});
