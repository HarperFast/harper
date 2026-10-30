'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { executeJob } = require('#src/server/serverHelpers/serverUtilities');

describe('executeJob', function () {
	this.timeout(10000);

	before(async function () {
		await testUtils.ensureSystemTables();
	});

	it('surfaces the error that kept its job row from being written', async function () {
		// The job row stores the request, and a symbol cannot be encoded into it.
		await assert.rejects(
			executeJob({ operation: 'restart_service', service: 'http', unencodable: Symbol() }),
			(error) => {
				assert.match(error.message, /Unknown type: symbol/);
				return true;
			}
		);
	});
});
