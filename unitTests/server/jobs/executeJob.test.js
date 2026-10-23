'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const sinon = require('sinon');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const { ServerError } = require('#src/utility/errors/hdbError');
const { executeJob } = require('#src/server/serverHelpers/serverUtilities');

describe('executeJob', function () {
	this.timeout(10000);

	before(async function () {
		await testUtils.ensureSystemTables();
	});

	afterEach(function () {
		sinon.restore();
	});

	it('surfaces the error that kept its job row from being written', async function () {
		const backPressure = new ServerError(
			'Outstanding write transactions have too long a queue, please try again later',
			503
		);
		sinon.stub(harperBridge, 'createRecords').rejects(backPressure);
		await assert.rejects(executeJob({ operation: 'restart_service', service: 'http' }), (error) => {
			assert.strictEqual(error, backPressure);
			return true;
		});
	});
});
