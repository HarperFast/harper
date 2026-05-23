'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const sinon = require('sinon');
const { METRIC } = require('#src/resources/analytics/metadata');
const { get, listMetrics, describeMetric /* collectDistinctValues */ } = require('#src/resources/analytics/read');

describe('get', () => {
	let searchStub;
	let mockAsyncIterable;

	beforeEach(() => {
		mockAsyncIterable = {
			[Symbol.asyncIterator]: async function* () {},
			map: function () {
				return this;
			},
		};

		global.databases = {
			system: {
				hdb_analytics: {
					search: sinon.stub().resolves(mockAsyncIterable),
				},
			},
		};
		global.server = { hostname: 'test-host' };

		searchStub = global.databases.system.hdb_analytics.search;
	});

	afterEach(() => {
		sinon.restore();
		delete global.databases;
		delete global.server;
	});

	function findIdCondition(conditions, comparator) {
		return conditions.find((c) => c.attribute === 'id' && c.comparator === comparator);
	}

	it('should not add any id condition when neither startTime nor endTime is provided', async () => {
		await get('cpu-usage');
		const { conditions } = searchStub.firstCall.args[0];
		expect(conditions.some((c) => c.attribute === 'id')).to.be.false;
	});

	it('should wrap startTime as a compound-key prefix for greater_than_equal', async () => {
		const startTime = 1779488703216;
		await get('cpu-usage', { startTime });
		const { conditions } = searchStub.firstCall.args[0];
		const cond = findIdCondition(conditions, 'greater_than_equal');
		expect(cond, 'expected a greater_than_equal condition on id').to.exist;
		// id is stored as [timestamp, nodeId]; a scalar bound would land outside
		// the array key range and return zero rows, so the bound must be wrapped.
		expect(cond.value).to.deep.equal([startTime]);
	});

	it('should wrap endTime as a compound-key prefix for less_than', async () => {
		const endTime = 1779488793222;
		await get('cpu-usage', { endTime });
		const { conditions } = searchStub.firstCall.args[0];
		const cond = findIdCondition(conditions, 'less_than');
		expect(cond, 'expected a less_than condition on id').to.exist;
		expect(cond.value).to.deep.equal([endTime]);
	});

	it('should emit both wrapped bounds when startTime and endTime are provided', async () => {
		const startTime = 1779488703216;
		const endTime = 1779488793222;
		await get('cpu-usage', { startTime, endTime });
		const { conditions } = searchStub.firstCall.args[0];
		const ge = findIdCondition(conditions, 'greater_than_equal');
		const lt = findIdCondition(conditions, 'less_than');
		expect(ge.value).to.deep.equal([startTime]);
		expect(lt.value).to.deep.equal([endTime]);
	});

	it('should treat startTime of 0 as a valid bound (not falsy)', async () => {
		await get('cpu-usage', { startTime: 0 });
		const { conditions } = searchStub.firstCall.args[0];
		const cond = findIdCondition(conditions, 'greater_than_equal');
		expect(cond).to.exist;
		expect(cond.value).to.deep.equal([0]);
	});
});

describe('listMetrics', () => {
	let searchStub;
	let mockAsyncIterable;

	beforeEach(() => {
		mockAsyncIterable = {
			[Symbol.asyncIterator]: async function* () {},
		};

		global.databases = {
			system: {
				hdb_analytics: {
					search: sinon.stub().returns(mockAsyncIterable),
				},
			},
		};

		// Keep a reference to the search stub for easier manipulation in tests
		searchStub = global.databases.system.hdb_analytics.search;
	});

	afterEach(() => {
		sinon.restore();
		delete global.databases;
	});

	it('should return built-in metrics by default', async () => {
		const result = await listMetrics();

		const expectedBuiltins = Object.values(METRIC);
		expect(result).to.deep.equal(expectedBuiltins);

		// Verify the search was not called since we only requested built-in metrics
		expect(searchStub.called).to.be.false;
	});

	it('should return built-in metrics when explicitly requested', async () => {
		const result = await listMetrics(['builtin']);

		const expectedBuiltins = Object.values(METRIC);
		expect(result).to.deep.equal(expectedBuiltins);

		// Verify the search was not called since we only requested built-in metrics
		expect(searchStub.called).to.be.false;
	});

	it('should return only custom metrics when only custom type is requested', async () => {
		const customMetrics = ['custom-metric-1', 'custom-metric-2'];
		mockAsyncIterable[Symbol.asyncIterator] = async function* () {
			for (const metric of customMetrics) {
				yield { metric };
			}
		};

		const result = await listMetrics(['custom']);

		// Verify custom metrics are returned and no built-ins
		expect(result).to.deep.equal(customMetrics);

		// Verify the search was called with correct parameters
		expect(searchStub.calledOnce).to.be.true;
		const searchParams = searchStub.firstCall.args[0];
		expect(searchParams.select).to.deep.equal(['metric']);
		// will have time window cutoff condition too, so one more than builtin metrics length
		expect(searchParams.conditions.length).to.equal(Object.keys(METRIC).length + 1);

		// Each condition after the first should be a 'not_equal' to a built-in metric
		const builtins = Object.values(METRIC);
		searchParams.conditions.slice(1).forEach((condition) => {
			expect(condition.attribute).to.equal('metric');
			expect(condition.comparator).to.equal('not_equal');
			expect(builtins).to.include(condition.value);
		});
	});

	it('should return both built-in and custom metrics when both types are requested', async () => {
		const customMetrics = ['custom-metric-1', 'custom-metric-2'];
		mockAsyncIterable[Symbol.asyncIterator] = async function* () {
			for (const metric of customMetrics) {
				yield { metric };
			}
		};

		const result = await listMetrics(['builtin', 'custom']);

		// Verify both built-in and custom metrics are returned
		const expectedBuiltins = Object.values(METRIC);
		const expected = [...expectedBuiltins, ...customMetrics];
		expect(result).to.have.members(expected);

		// Verify the search was called
		expect(searchStub.calledOnce).to.be.true;
	});

	it('should handle empty search results for custom metrics', async () => {
		mockAsyncIterable[Symbol.asyncIterator] = async function* () {
			// yield nothing
		};

		const result = await listMetrics(['builtin', 'custom']);

		// Verify only built-in metrics are returned
		const expectedBuiltins = Object.values(METRIC);
		expect(result).to.deep.equal(expectedBuiltins);

		// Verify the search was called
		expect(searchStub.calledOnce).to.be.true;
	});

	it('should deduplicate custom metrics', async () => {
		mockAsyncIterable[Symbol.asyncIterator] = async function* () {
			yield { metric: 'custom-metric-1' };
			yield { metric: 'custom-metric-1' }; // Duplicate
			yield { metric: 'custom-metric-2' };
		};

		const result = await listMetrics(['custom']);

		// Verify duplicates are removed
		expect(result).to.deep.equal(['custom-metric-1', 'custom-metric-2']);

		// Verify the search was called
		expect(searchStub.calledOnce).to.be.true;
	});

	it('should set a default custom metric time window of one week', async () => {
		const weekAgo = Date.now() - 1000 * 60 * 60 * 24 * 7;
		await listMetrics(['custom']);
		const firstCondition = searchStub.firstCall.args[0].conditions[0];
		expect(firstCondition.attribute).to.be.equal('id');
		expect(firstCondition.comparator).to.be.equal('greater_than');
		// id is a compound key, so the bound is wrapped in an array
		expect(firstCondition.value).to.be.an('array').with.lengthOf(1);
		expect(firstCondition.value[0]).to.be.approximately(weekAgo, 1000);
	});

	it('should use the given metric time window when provided', async () => {
		const twoDays = 1000 * 60 * 60 * 24 * 2;
		await listMetrics(['custom'], twoDays);
		const firstCondition = searchStub.firstCall.args[0].conditions[0];
		expect(firstCondition.attribute).to.be.equal('id');
		expect(firstCondition.comparator).to.be.equal('greater_than');
		expect(firstCondition.value).to.be.an('array').with.lengthOf(1);
		expect(firstCondition.value[0]).to.be.approximately(Date.now() - twoDays, 1000);
	});

	it('should return empty array when no metric types are requested', async () => {
		const result = await listMetrics([]);

		expect(result).to.be.an('array').that.is.empty;
		expect(searchStub.called).to.be.false;
	});

	it('should handle database search errors', async () => {
		// Make the search throw an error
		searchStub.throws(new Error('Database error'));

		try {
			await listMetrics(['custom']);
			// Should not reach here
			expect.fail('Expected an error to be thrown');
		} catch (error) {
			expect(error.message).to.equal('Database error');
		}
	});

	it('should handle invalid metric type gracefully', async () => {
		// @ts-expect-error - intentionally passing invalid type for test
		const result = await listMetrics(['invalid-type']);

		// Should return an empty array since no valid types were requested
		expect(result).to.be.an('array').that.is.empty;
		expect(searchStub.called).to.be.false;
	});

	it('should build correct conditions for searching custom metrics', async () => {
		await listMetrics(['custom']);

		// Verify the search conditions
		const searchParams = searchStub.firstCall.args[0];
		const builtins = Object.values(METRIC);

		// Should have one condition per built-in metric
		expect(searchParams.conditions.length).to.equal(builtins.length + 1);

		// Should set a time window cutoff as the first condition
		expect(searchParams.conditions[0].attribute).to.equal('id');
		expect(searchParams.conditions[0].comparator).to.equal('greater_than');
		expect(searchParams.conditions[0].value).to.be.an('array').with.lengthOf(1);
		expect(searchParams.conditions[0].value[0]).to.be.lessThan(Date.now());

		// Each condition should be checking "not equal" to a built-in metric
		for (let i = 0; i < builtins.length; i++) {
			expect(searchParams.conditions[i + 1]).to.deep.equal({
				attribute: 'metric',
				comparator: 'not_equal',
				value: builtins[i],
			});
		}
	});
});

describe('describeMetric', () => {
	// Mock data and stubs
	let mockSearchResults;
	let searchStub;
	let mockAsyncIterable;

	beforeEach(() => {
		// Create a default mock result
		mockSearchResults = {
			id: [1234567890, 1],
			metric: 'test-metric',
			path: '/api/test',
			method: 'GET',
			type: 'rest',
			value: 100,
			count: 5,
		};

		// Mock async iterable for the search results
		mockAsyncIterable = {
			[Symbol.asyncIterator]: async function* () {
				yield mockSearchResults;
			},
		};

		// Setup global databases object with stub method
		global.databases = {
			system: {
				hdb_analytics: {
					search: sinon.stub().returns(mockAsyncIterable),
				},
			},
		};

		// Keep a reference to the search stub for easier manipulation in tests
		searchStub = global.databases.system.hdb_analytics.search;
	});

	afterEach(() => {
		sinon.restore();
		delete global.databases;
	});

	it('should return empty object when no metrics are found', async () => {
		// Override the mock async iterable to yield no results
		mockAsyncIterable[Symbol.asyncIterator] = async function* () {
			// yield nothing
		};

		const result = await describeMetric('non-existent-metric');

		expect(result).to.deep.equal({});
		expect(searchStub.calledOnce).to.be.true;

		// Verify search was called with correct parameters
		const searchParams = searchStub.firstCall.args[0];
		expect(searchParams.conditions).to.have.lengthOf(1);
		expect(searchParams.conditions[0]).to.deep.equal({
			attribute: 'metric',
			comparator: 'equals',
			value: 'non-existent-metric',
		});
		expect(searchParams.sort).to.deep.equal({
			attribute: 'id',
			descending: true,
		});
	});

	it('should return metric attributes when metric is found', async () => {
		const result = await describeMetric('test-metric');

		expect(result).to.have.property('attributes');
		expect(result.attributes).to.deep.include.members([
			{ name: 'node', type: 'string' },
			{ name: 'id', type: 'object' },
			{ name: 'metric', type: 'string' },
			{ name: 'path', type: 'string' },
			{ name: 'method', type: 'string' },
			{ name: 'type', type: 'string' },
			{ name: 'value', type: 'number' },
			{ name: 'count', type: 'number' },
		]);
		expect(searchStub.calledOnce).to.be.true;
	});

	it('should handle errors in the search operation', async () => {
		searchStub.throws(new Error('Database error'));

		try {
			await describeMetric('test-metric');
			// Should not reach here
			expect.fail('Expected an error to be thrown');
		} catch (error) {
			expect(error.message).to.equal('Database error');
		}
	});
});
