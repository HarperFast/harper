'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const sinon = require('sinon');
const rewire = require('rewire');

const role_rw = rewire('#js/security/role');

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
			role_rw.__set__('databases', {
				system: { hdb_role: { search: searchStub } },
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
});
