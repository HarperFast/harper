'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { default: harperBridge } = require('#src/dataLayer/harperBridge/harperBridge');
const { alterRole } = require('#src/security/role');
const { ClientError } = require('#src/utility/errors/hdbError');

const PERMISSION = { super_user: false };

describe('security/role alterRole() error status', () => {
	let originalUpdateRecords;

	before(async () => {
		await testUtils.ensureSystemTables();
	});

	beforeEach(() => {
		originalUpdateRecords = harperBridge.updateRecords;
	});

	afterEach(() => {
		harperBridge.updateRecords = originalUpdateRecords;
	});

	async function alterRejection(updateError) {
		let calls = 0;
		harperBridge.updateRecords = async () => {
			calls++;
			throw updateError;
		};
		const err = await alterRole({ id: 'some_role', permission: PERMISSION }).then(
			() => assert.fail('alterRole should have rejected'),
			(e) => e
		);
		assert.strictEqual(calls, 1);
		return err;
	}

	it('keeps the 400 the real update pipeline raises for a reserved role id', async () => {
		await assert.rejects(alterRole({ id: 'null', permission: PERMISSION }), (err) => {
			assert.strictEqual(err.statusCode, 400);
			assert.match(err.message, /Invalid hash value/);
			return true;
		});
	});

	for (const statusCode of [400, 405]) {
		it(`keeps a ClientError ${statusCode} thrown by update`, async () => {
			const err = await alterRejection(new ClientError('write refused', statusCode));
			assert.strictEqual(err.statusCode, statusCode);
			assert.strictEqual(err.message, 'write refused');
		});
	}

	it('wraps an unexpected error as a 500', async () => {
		const err = await alterRejection(new Error('disk exploded'));
		assert.strictEqual(err.statusCode, 500);
	});
});
