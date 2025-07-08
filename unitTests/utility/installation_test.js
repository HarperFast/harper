const { isHdbInstalled } = require('../../utility/installation');
const sandbox = require('sinon');
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('path');
const envMangr = require('../../utility/environment/environmentManager');
const testUtils = require('../test_utils');
const terms = require('../../utility/hdbTerms');

describe('Test isHdbInstalled function', () => {
	let fsStatStub;
	let envStub;
	let loggerStub;
	let logErrorStub;
	const TEST_ERROR = 'I am a unit test error test';

	before(() => {
		fsStatStub = sandbox.stub(fs, 'statSync');
		envStub = sandbox.stub(envMangr, 'get');
		envStub.withArgs(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY).returns(`harperdb${path.sep}unitTests${path.sep}settings.test`);
		loggerStub = {};
		logErrorStub = sandbox.stub().callsFake(() => {});
		loggerStub.error = logErrorStub;
	});

	beforeEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		fsStatStub.restore();
	});

	it('Test two calls to fs stat with the correct arguments happy path', async () => {
		const result = isHdbInstalled(envMangr, loggerStub);

		expect(result).to.be.true;
		expect(fsStatStub.getCall(1).args[0]).to.include(`harperdb${path.sep}unitTests${path.sep}settings.test`);
	});

	it('Test ENOENT err code returns false', async () => {
		let err = new Error(TEST_ERROR);
		err.code = 'ENOENT';
		fsStatStub.throws(err);
		const result = isHdbInstalled(envMangr, loggerStub);

		expect(result).to.be.false;
	});

	it('Test non ENOENT error is handled as expected', async () => {
		fsStatStub.throws(new Error(TEST_ERROR));
		testUtils.assertErrorSync(isHdbInstalled, [envMangr, loggerStub], new Error(TEST_ERROR));
		expect(logErrorStub.getCall(0).firstArg).to.equal(
			'Error checking for HDB install - Error: I am a unit test error test'
		);
	});
});
