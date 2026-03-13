'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const { applyImpersonation } = require('#src/security/impersonation');
const userModule = require('#src/security/user');
const roleModule = require('#src/security/role');
const harperLogger = require('#js/utility/logging/harper_logger');

// Separate sandbox for per-test stubs (e.g. getUsersWithRolesCache in Mode B tests)
// so we can restore them without killing the permanent logger stub.
const perTestSandbox = sinon.createSandbox();

function makeSuperUser(username = 'HDB_ADMIN') {
	return {
		username,
		active: true,
		role: {
			permission: { super_user: true },
			role: 'super_user',
			id: 'test-su-id',
			__updatedtime__: Date.now(),
			__createdtime__: Date.now(),
		},
	};
}

function makeNonSuperUser(username = 'basic_user') {
	return {
		username,
		active: true,
		role: {
			permission: {
				super_user: false,
				dev: {
					tables: {
						dog: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
					},
				},
			},
			role: 'basic_role',
			id: 'test-basic-id',
			__updatedtime__: Date.now(),
			__createdtime__: Date.now(),
		},
	};
}

describe('security/impersonation.ts', () => {
	before(() => {
		sandbox.stub(harperLogger, 'info').callsFake(() => {});
	});

	afterEach(() => {
		perTestSandbox.restore();
	});

	after(() => {
		sandbox.restore();
	});

	describe('applyImpersonation - gate check', () => {
		it('should reject non-super-user with 403', async () => {
			const nonSU = makeNonSuperUser();
			const payload = { username: 'someone' };

			await assert.rejects(
				() => applyImpersonation(nonSU, payload),
				(err) => {
					assert.strictEqual(err.statusCode, 403);
					assert.match(err.message, /super_user/i);
					return true;
				}
			);
		});

		it('should reject user with no role', async () => {
			const noRole = { username: 'norole' };
			const payload = { username: 'someone' };

			await assert.rejects(
				() => applyImpersonation(noRole, payload),
				(err) => {
					assert.strictEqual(err.statusCode, 403);
					return true;
				}
			);
		});

		it('should reject null authenticatedUser', async () => {
			await assert.rejects(
				() => applyImpersonation(null, { username: 'someone' }),
				(err) => {
					assert.strictEqual(err.statusCode, 403);
					return true;
				}
			);
		});

		it('should reject undefined authenticatedUser', async () => {
			await assert.rejects(
				() => applyImpersonation(undefined, { username: 'someone' }),
				(err) => {
					assert.strictEqual(err.statusCode, 403);
					return true;
				}
			);
		});

		it('should reject user with role but no permission property', async () => {
			const badRole = { username: 'badrole', role: { role: 'x', id: 'x', __updatedtime__: 0, __createdtime__: 0 } };
			await assert.rejects(
				() => applyImpersonation(badRole, { username: 'someone' }),
				(err) => {
					assert.strictEqual(err.statusCode, 403);
					return true;
				}
			);
		});
	});

	describe('applyImpersonation - payload validation', () => {
		it('should reject null payload', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, null),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					return true;
				}
			);
		});

		it('should reject payload with neither username, role_name, nor role', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, {}),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /username|role_name|role/i);
					return true;
				}
			);
		});

		it('should reject payload with empty username and no role', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, { username: '' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					return true;
				}
			);
		});

		it('should reject payload with non-object role', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, { role: 'bad' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /role.*object/i);
					return true;
				}
			);
		});

		it('should reject payload with role missing permission', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, { role: {} }),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /permission/i);
					return true;
				}
			);
		});

		it('should reject array payload', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, [{ username: 'x' }]),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /object/i);
					return true;
				}
			);
		});

		it('should reject role with null permission', async () => {
			const su = makeSuperUser();
			await assert.rejects(
				() => applyImpersonation(su, { role: { permission: null } }),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /permission/i);
					return true;
				}
			);
		});

		it('should reject operations field that is not an array', async () => {
			const su = makeSuperUser();
			const payload = { role: { permission: { operations: 'read_only' } } };
			await assert.rejects(
				() => applyImpersonation(su, payload),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /operations.*array/i);
					return true;
				}
			);
		});

		it('should reject non-string entries in operations array', async () => {
			const su = makeSuperUser();
			const payload = { role: { permission: { operations: [123, null] } } };
			await assert.rejects(
				() => applyImpersonation(su, payload),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /unknown operation/i);
					return true;
				}
			);
		});

		it('should reject invalid operations entries', async () => {
			const su = makeSuperUser();
			const payload = {
				role: {
					permission: {
						operations: ['search_by_hash', 'totally_fake_op'],
					},
				},
			};
			await assert.rejects(
				() => applyImpersonation(su, payload),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /totally_fake_op/);
					return true;
				}
			);
		});

		it('should accept valid operations including group names', async () => {
			const su = makeSuperUser();
			const payload = {
				role: {
					permission: {
						operations: ['read_only', 'insert'],
					},
				},
			};
			const result = await applyImpersonation(su, payload);
			assert.deepStrictEqual(result.role.permission.operations, ['read_only', 'insert']);
		});
	});

	describe('applyImpersonation - Mode A (inline permissions)', () => {
		it('should return synthetic user with inline permissions', async () => {
			const su = makeSuperUser();
			const payload = {
				role: {
					permission: {
						dev: {
							tables: {
								dog: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				},
			};

			const result = await applyImpersonation(su, payload);
			assert.strictEqual(result.username, 'HDB_ADMIN');
			assert.strictEqual(result.role.permission.super_user, false);
			assert.strictEqual(result.role.role, '_impersonated');
			assert.deepStrictEqual(result.role.permission.dev, payload.role.permission.dev);
		});

		it('should use provided username for audit context', async () => {
			const su = makeSuperUser();
			const payload = {
				username: 'test_context',
				role: {
					permission: { super_user: false },
				},
			};

			const result = await applyImpersonation(su, payload);
			assert.strictEqual(result.username, 'test_context');
			assert.strictEqual(result._impersonatedBy, 'HDB_ADMIN');
		});

		it('should force super_user: false even if payload says true', async () => {
			const su = makeSuperUser();
			const payload = {
				role: {
					permission: { super_user: true },
				},
			};

			const result = await applyImpersonation(su, payload);
			assert.strictEqual(result.role.permission.super_user, false);
		});

		it('should force cluster_user: false even if payload says true', async () => {
			const su = makeSuperUser();
			const payload = {
				role: {
					permission: { cluster_user: true },
				},
			};

			const result = await applyImpersonation(su, payload);
			assert.strictEqual(result.role.permission.cluster_user, false);
		});

		it('should use Mode A (inline) when both role and username are provided', async () => {
			const su = makeSuperUser();
			const payload = {
				username: 'custom_context',
				role: {
					permission: {
						dev: {
							tables: {
								dog: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				},
			};

			const result = await applyImpersonation(su, payload);
			// Should use inline permissions, not look up 'custom_context' from cache
			assert.strictEqual(result.role.role, '_impersonated');
			assert.strictEqual(result.username, 'custom_context');
			assert.ok(result.role.permission.dev);
		});
	});

	describe('applyImpersonation - Mode B (existing user lookup)', () => {
		it('should return cloned user from cache', async () => {
			const su = makeSuperUser();
			const targetUser = makeNonSuperUser('readonly_user');
			const cacheMap = new Map([['readonly_user', targetUser]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			const result = await applyImpersonation(su, { username: 'readonly_user' });
			assert.strictEqual(result.username, 'readonly_user');
			assert.strictEqual(result.role.permission.super_user, false);
			assert.strictEqual(result.role.id, '_impersonated_readonly_user');
			assert.strictEqual(result._impersonated, true);
			assert.strictEqual(result._impersonatedBy, 'HDB_ADMIN');
			// Should be a clone, not the same reference
			assert.notStrictEqual(result, targetUser);
			assert.notStrictEqual(result.role, targetUser.role);
			assert.notStrictEqual(result.role.permission, targetUser.role.permission);
		});

		it('should throw 404 for non-existent user', async () => {
			const su = makeSuperUser();
			const cacheMap = new Map();
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			await assert.rejects(
				() => applyImpersonation(su, { username: 'ghost_user' }),
				(err) => {
					assert.strictEqual(err.statusCode, 404);
					assert.match(err.message, /ghost_user/);
					return true;
				}
			);
		});

		it('should force super_user: false on looked-up super user', async () => {
			const su = makeSuperUser();
			const targetSU = makeSuperUser('other_admin');
			const cacheMap = new Map([['other_admin', targetSU]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			const result = await applyImpersonation(su, { username: 'other_admin' });
			assert.strictEqual(result.role.permission.super_user, false);
		});

		it('should force cluster_user: false on looked-up cluster user', async () => {
			const su = makeSuperUser();
			const targetCluster = {
				username: 'cluster_user',
				active: true,
				role: {
					permission: { super_user: false, cluster_user: true },
					role: 'cluster_role',
					id: 'test-cluster-id',
					__updatedtime__: Date.now(),
					__createdtime__: Date.now(),
				},
			};
			const cacheMap = new Map([['cluster_user', targetCluster]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			const result = await applyImpersonation(su, { username: 'cluster_user' });
			assert.strictEqual(result.role.permission.cluster_user, false);
		});

		it('should NOT mutate the original cache entry after enforceDowngrade', async () => {
			const su = makeSuperUser();
			const targetSU = makeSuperUser('other_admin');
			const cacheMap = new Map([['other_admin', targetSU]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			await applyImpersonation(su, { username: 'other_admin' });

			// The original cache entry must still have super_user: true
			const cached = cacheMap.get('other_admin');
			assert.strictEqual(cached.role.permission.super_user, true);
		});

		it('should reject impersonation of inactive user with 403', async () => {
			const su = makeSuperUser();
			const inactiveUser = makeNonSuperUser('disabled_user');
			inactiveUser.active = false;
			const cacheMap = new Map([['disabled_user', inactiveUser]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			await assert.rejects(
				() => applyImpersonation(su, { username: 'disabled_user' }),
				(err) => {
					assert.strictEqual(err.statusCode, 403);
					assert.match(err.message, /inactive/i);
					return true;
				}
			);
		});

		it('should handle looked-up user with no role gracefully', async () => {
			const su = makeSuperUser();
			const noRoleUser = { username: 'norole_user', active: true };
			const cacheMap = new Map([['norole_user', noRoleUser]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);

			const result = await applyImpersonation(su, { username: 'norole_user' });
			assert.strictEqual(result.username, 'norole_user');
			assert.strictEqual(result.role, undefined);
			assert.strictEqual(result._impersonatedBy, 'HDB_ADMIN');
		});
	});

	describe('applyImpersonation - Mode C (role name lookup)', () => {
		function makeRoleRecord(roleName, permission = { super_user: false }) {
			return {
				permission,
				role: roleName,
				id: `${roleName}-id`,
				__updatedtime__: Date.now(),
				__createdtime__: Date.now(),
			};
		}

		function stubGetRoleByName(result) {
			perTestSandbox.stub(roleModule, 'getRoleByName').resolves(result);
		}

		it('should return synthetic user with the looked-up role permissions', async () => {
			const su = makeSuperUser();
			const role = makeRoleRecord('readonly_role', {
				super_user: false,
				dev: {
					tables: {
						dog: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
					},
				},
			});
			stubGetRoleByName(role);

			const result = await applyImpersonation(su, { role_name: 'readonly_role' });
			assert.strictEqual(result.username, 'HDB_ADMIN');
			assert.strictEqual(result.role.permission.super_user, false);
			assert.ok(result.role.permission.dev);
		});

		it('should use provided username for audit context', async () => {
			const su = makeSuperUser();
			stubGetRoleByName(makeRoleRecord('basic_role'));

			const result = await applyImpersonation(su, { role_name: 'basic_role', username: 'test_context' });
			assert.strictEqual(result.username, 'test_context');
			assert.strictEqual(result._impersonatedBy, 'HDB_ADMIN');
		});

		it('should throw 404 for non-existent role name', async () => {
			const su = makeSuperUser();
			stubGetRoleByName(null);

			await assert.rejects(
				() => applyImpersonation(su, { role_name: 'ghost_role' }),
				(err) => {
					assert.strictEqual(err.statusCode, 404);
					assert.match(err.message, /ghost_role/);
					return true;
				}
			);
		});

		it('should force super_user: false on looked-up role', async () => {
			const su = makeSuperUser();
			stubGetRoleByName(makeRoleRecord('admin_role', { super_user: true }));

			const result = await applyImpersonation(su, { role_name: 'admin_role' });
			assert.strictEqual(result.role.permission.super_user, false);
		});

		it('should force cluster_user: false on looked-up role', async () => {
			const su = makeSuperUser();
			stubGetRoleByName(makeRoleRecord('cluster_role', { super_user: false, cluster_user: true }));

			const result = await applyImpersonation(su, { role_name: 'cluster_role' });
			assert.strictEqual(result.role.permission.cluster_user, false);
		});

		it('should NOT mutate the original role record', async () => {
			const su = makeSuperUser();
			const role = makeRoleRecord('su_role', { super_user: true });
			stubGetRoleByName(role);

			await applyImpersonation(su, { role_name: 'su_role' });

			assert.strictEqual(role.permission.super_user, true);
		});

		it('should prefer Mode A when both role and role_name are provided', async () => {
			const su = makeSuperUser();
			const payload = {
				role_name: 'some_role',
				role: {
					permission: {
						dev: {
							tables: {
								dog: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				},
			};

			const result = await applyImpersonation(su, payload);
			assert.strictEqual(result.role.role, '_impersonated');
			assert.ok(result.role.permission.dev);
		});
	});

	describe('applyImpersonation - audit trail', () => {
		it('should set _impersonated and _impersonatedBy on the result', async () => {
			const su = makeSuperUser();
			const payload = {
				role: {
					permission: { super_user: false },
				},
			};

			const result = await applyImpersonation(su, payload);
			assert.strictEqual(result._impersonated, true);
			assert.strictEqual(result._impersonatedBy, 'HDB_ADMIN');
		});

		it('should set _impersonated role id consistently across all modes', async () => {
			const su = makeSuperUser();

			// Mode A
			const modeA = await applyImpersonation(su, {
				username: 'ctx_user',
				role: { permission: { super_user: false } },
			});
			assert.strictEqual(modeA.role.id, '_impersonated_ctx_user');

			// Mode B
			const targetUser = makeNonSuperUser('lookup_user');
			const cacheMap = new Map([['lookup_user', targetUser]]);
			perTestSandbox.stub(userModule, 'getUsersWithRolesCache').resolves(cacheMap);
			const modeB = await applyImpersonation(su, { username: 'lookup_user' });
			assert.strictEqual(modeB.role.id, '_impersonated_lookup_user');
			perTestSandbox.restore();

			// Mode C
			const roleRecord = {
				permission: { super_user: false },
				role: 'test_role',
				id: 'test_role',
				__updatedtime__: Date.now(),
				__createdtime__: Date.now(),
			};
			perTestSandbox.stub(roleModule, 'getRoleByName').resolves(roleRecord);
			const modeC = await applyImpersonation(su, { role_name: 'test_role', username: 'ctx_user' });
			assert.strictEqual(modeC.role.id, '_impersonated_ctx_user');
		});
	});
});
