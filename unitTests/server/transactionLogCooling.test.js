'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');

const env = require('#src/utility/environment/environmentManager');
const { logger } = require('#src/utility/logging/logger');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const {
	runCoolingPass,
	startTransactionLogCooling,
	setCoolingFunctionForTests,
} = require('#src/server/transactionLogCooling');

const COOLING_INTERVAL = CONFIG_PARAMS.STORAGE_TRANSACTIONLOG_COOLINGINTERVAL;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('transaction log cooling', () => {
	let sandbox;
	let originalTrace;
	let originalError;

	beforeEach(() => {
		sandbox = sinon.createSandbox();
		// logger.trace/error are conditionally present based on log level; install
		// stubs unconditionally so assertions are deterministic.
		originalTrace = logger.trace;
		originalError = logger.error;
		logger.trace = sandbox.stub();
		logger.error = sandbox.stub();
	});

	afterEach(() => {
		// clears any running timer and resets the cooling function
		setCoolingFunctionForTests(undefined);
		logger.trace = originalTrace;
		logger.error = originalError;
		sandbox.restore();
	});

	describe('runCoolingPass', () => {
		it('invokes the cooling function and traces when maps were cooled', () => {
			const cool = sandbox.stub().returns({ maps: 2, bytes: 8192 });
			setCoolingFunctionForTests(cool);
			runCoolingPass();
			assert.ok(cool.calledOnce, 'cooling function should be called once');
			assert.ok(logger.trace.calledOnce, 'should trace when maps > 0');
		});

		it('does not trace when nothing was cooled', () => {
			const cool = sandbox.stub().returns({ maps: 0, bytes: 0 });
			setCoolingFunctionForTests(cool);
			runCoolingPass();
			assert.ok(cool.calledOnce);
			assert.ok(logger.trace.notCalled, 'should not trace when maps === 0');
		});

		it('swallows and logs errors thrown by the cooling function', () => {
			const cool = sandbox.stub().throws(new Error('boom'));
			setCoolingFunctionForTests(cool);
			assert.doesNotThrow(() => runCoolingPass());
			assert.ok(logger.error.calledOnce, 'should log the error');
		});

		it('is a no-op when the cooling function is unavailable', () => {
			setCoolingFunctionForTests(undefined);
			assert.doesNotThrow(() => runCoolingPass());
			assert.ok(logger.error.notCalled);
		});
	});

	describe('startTransactionLogCooling', () => {
		it('does not schedule when cooling is unavailable', async () => {
			setCoolingFunctionForTests(undefined);
			sandbox.stub(env, 'get').withArgs(COOLING_INTERVAL).returns('0.02');
			startTransactionLogCooling();
			await delay(60);
			// nothing to assert beyond "did not throw / did not schedule a real pass";
			// the unavailable guard returns before reading config.
		});

		it('does not schedule when the interval is 0 (disabled)', async () => {
			const cool = sandbox.stub().returns({ maps: 1, bytes: 4096 });
			setCoolingFunctionForTests(cool);
			sandbox.stub(env, 'get').withArgs(COOLING_INTERVAL).returns(0);
			startTransactionLogCooling();
			await delay(60);
			assert.ok(cool.notCalled, 'disabled cooling should never fire');
		});

		it('schedules a recurring cooling pass at the configured interval', async () => {
			const cool = sandbox.stub().returns({ maps: 1, bytes: 4096 });
			setCoolingFunctionForTests(cool);
			// '0.02' -> 20ms (convertToMS treats the base unit as seconds)
			sandbox.stub(env, 'get').withArgs(COOLING_INTERVAL).returns('0.02');
			startTransactionLogCooling();
			await delay(70);
			assert.ok(cool.callCount >= 2, `expected repeated cooling passes, got ${cool.callCount}`);
		});
	});
});
