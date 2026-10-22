'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const sinon = require('sinon');
const rewire = require('rewire');

const role_rw = rewire('#src/security/role');
const { ClientError } = require('#src/utility/errors/hdbError');

const sandbox = sinon.createSandbox();

describe('security/role.js', () => {
	afterEach(() => {
		sandbox.restore();
	});

	describe('getRoleByName()', () => {
		let searchStub;

		function stubSearch(results) {
			async function* gen() {
				if (results) yield* results;
			}
			searchStub = sandbox.stub().returns(gen());
			role_rw.__set__('databases_ts_1', {
				databases: { system: { hdb_role: { search: searchStub } } },
			});
		}

		it('should pass correct search parameters', async () => {
			stubSearch([{ id: 'test', role: 'test' }]);

			await role_rw.getRoleByName('readonly_role');

			assert.strictEqual(searchStub.callCount, 1);
			const searchArg = searchStub.firstCall.args[0];
			assert.deepStrictEqual(searchArg, [{ attribute: 'role', value: 'readonly_role' }]);
		});

		it('should return null when search returns no results', async () => {
			stubSearch([]);

			const result = await role_rw.getRoleByName('nonexistent_role');
			assert.strictEqual(result, null);
		});

		it('should return the first matching role', async () => {
			const roleRecord = { id: 'readonly_role', role: 'readonly_role' };
			stubSearch([roleRecord]);

			const result = await role_rw.getRoleByName('readonly_role');
			assert.deepStrictEqual(result, roleRecord);
		});
	});

	describe('alterRole()', () => {
		function stubUpdate(error) {
			const updateStub = sandbox.stub().rejects(error);
			role_rw.__set__('insert', { update: updateStub });
			role_rw.__set__('user_ts_1', { assertActiveSuperUserRemains: async () => {} });
			return updateStub;
		}

		for (const statusCode of [400, 405]) {
			it(`preserves a ClientError ${statusCode} from update`, async () => {
				stubUpdate(new ClientError('write refused', statusCode));

				await assert.rejects(role_rw.alterRole({ id: 'some_role', permission: { super_user: false } }), (err) => {
					assert.strictEqual(err.statusCode, statusCode);
					assert.strictEqual(err.message, 'write refused');
					return true;
				});
			});
		}

		it('wraps an unexpected error as a 500', async () => {
			stubUpdate(new Error('disk exploded'));

			await assert.rejects(role_rw.alterRole({ id: 'some_role', permission: { super_user: false } }), (err) => {
				assert.strictEqual(err.statusCode, 500);
				return true;
			});
		});
	});
});
