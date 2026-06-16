'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const sinon = require('sinon');
const { METRIC } = require('#src/resources/analytics/metadata');
const { getOp, listMetrics, describeMetric /* collectDistinctValues */ } = require('#src/resources/analytics/read');
const { getThisNodeName } = require('#src/server/nodeName');
const hostnames = require('#src/resources/analytics/hostnames');

// Mimics the Harper search iterable: array-like with a lazy async `.map`, which is
// what resources/analytics/read.ts `get()` consumes.
function mockSearchIterable(items) {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const item of items) yield item;
		},
		map(fn) {
			return {
				[Symbol.asyncIterator]: async function* () {
					for (const item of items) yield await fn(item);
				},
			};
		},
	};
}

async function collect(result) {
	const out = [];
	for await (const item of result) out.push(item);
	return out;
}

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
		expect(firstCondition.value).to.be.approximately(weekAgo, 1000);
	});

	it('should use the given metric time window when provided', async () => {
		const twoDays = 1000 * 60 * 60 * 24 * 2;
		await listMetrics(['custom'], twoDays);
		const firstCondition = searchStub.firstCall.args[0].conditions[0];
		expect(firstCondition.attribute).to.be.equal('id');
		expect(firstCondition.comparator).to.be.equal('greater_than');
		expect(firstCondition.value).to.be.approximately(Date.now() - twoDays, 1000);
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
		expect(searchParams.conditions[0].value).to.be.lessThan(Date.now());

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

describe('getOp (replicated fan-out)', () => {
	let searchStub;
	let sendOperationStub;
	let originalServer;
	let originalDatabases;

	beforeEach(() => {
		// `server` and `databases` are process-wide globals established at module load;
		// stash and restore them rather than deleting so later test files still see them.
		originalServer = global.server;
		originalDatabases = global.databases;

		searchStub = sinon.stub().returns(mockSearchIterable([]));
		// `replicate === false` => analytics are NOT replicated by the DB layer, so the
		// fan-out is needed (and enabled). The skip case is covered explicitly below.
		global.databases = { system: { hdb_analytics: { search: searchStub, replicate: false } } };

		sendOperationStub = sinon.stub();
		global.server = {
			hostname: 'local-host',
			nodes: [],
			replication: { sendOperationToNode: sendOperationStub },
		};
	});

	afterEach(() => {
		sinon.restore();
		global.server = originalServer;
		global.databases = originalDatabases;
	});

	it('merges metrics from every peer node into one flat result set', async () => {
		global.server.nodes = [{ name: 'peer-a' }, { name: 'peer-b' }];
		sendOperationStub
			.withArgs(sinon.match({ name: 'peer-a' }))
			.resolves({ results: [{ id: 1, metric: 'm', node: 'peer-a' }] });
		sendOperationStub
			.withArgs(sinon.match({ name: 'peer-b' }))
			.resolves({ results: [{ id: 2, metric: 'm', node: 'peer-b' }] });

		const result = await collect(await getOp({ operation: 'get_analytics', metric: 'm', replicated: true }));

		expect(result).to.deep.equal([
			{ id: 1, metric: 'm', node: 'peer-a' },
			{ id: 2, metric: 'm', node: 'peer-b' },
		]);
		expect(sendOperationStub.calledTwice).to.be.true;
	});

	it('forwards the query to peers with `replicated` cleared (no recursive fan-out)', async () => {
		global.server.nodes = [{ name: 'peer-a' }];
		sendOperationStub.resolves({ results: [] });

		await collect(await getOp({ operation: 'get_analytics', metric: 'm', replicated: true }));

		const forwarded = sendOperationStub.firstCall.args[1];
		expect(forwarded.replicated).to.equal(false);
		expect(forwarded.metric).to.equal('m');
	});

	it('skips the local node when fanning out', async () => {
		const thisNode = getThisNodeName();
		global.server.nodes = [{ name: thisNode }, { name: 'peer-x' }];
		sendOperationStub.resolves({ results: [] });

		await collect(await getOp({ metric: 'm', replicated: true }));

		expect(sendOperationStub.calledOnce).to.be.true;
		expect(sendOperationStub.firstCall.args[0]).to.deep.equal({ name: 'peer-x' });
	});

	it('omits a peer that errors and still returns the others (best-effort)', async () => {
		global.server.nodes = [{ name: 'peer-good' }, { name: 'peer-bad' }];
		sendOperationStub
			.withArgs(sinon.match({ name: 'peer-good' }))
			.resolves({ results: [{ id: 1, metric: 'm', node: 'peer-good' }] });
		sendOperationStub.withArgs(sinon.match({ name: 'peer-bad' })).rejects(new Error('connection refused'));

		const result = await collect(await getOp({ metric: 'm', replicated: true }));

		expect(result).to.deep.equal([{ id: 1, metric: 'm', node: 'peer-good' }]);
	});

	it('accepts a bare-array peer response (defensive unwrap)', async () => {
		global.server.nodes = [{ name: 'peer-a' }];
		sendOperationStub.resolves([{ id: 5, metric: 'm', node: 'peer-a' }]);

		const result = await collect(await getOp({ metric: 'm', replicated: true }));

		expect(result).to.deep.equal([{ id: 5, metric: 'm', node: 'peer-a' }]);
	});

	it('treats a malformed peer response (non-array results) as empty', async () => {
		global.server.nodes = [{ name: 'peer-good' }, { name: 'peer-weird' }];
		sendOperationStub
			.withArgs(sinon.match({ name: 'peer-good' }))
			.resolves({ results: [{ id: 1, metric: 'm', node: 'peer-good' }] });
		sendOperationStub.withArgs(sinon.match({ name: 'peer-weird' })).resolves({ results: 'not-an-array' });

		const result = await collect(await getOp({ metric: 'm', replicated: true }));

		expect(result).to.deep.equal([{ id: 1, metric: 'm', node: 'peer-good' }]);
	});

	it('includes local node results ahead of peer results', async () => {
		sinon
			.stub(hostnames, 'getAnalyticsHostnameTable')
			.returns({ get: sinon.stub().resolves({ hostname: 'local-host' }) });
		searchStub.returns(mockSearchIterable([{ id: [10, 12345], metric: 'm', total: 1 }]));
		global.server.nodes = [{ name: 'peer-a' }];
		sendOperationStub.resolves({ results: [{ id: 20, metric: 'm', node: 'peer-a', total: 2 }] });

		const result = await collect(await getOp({ metric: 'm', replicated: true }));

		expect(result).to.deep.equal([
			{ id: 10, metric: 'm', total: 1, node: 'local-host' },
			{ id: 20, metric: 'm', node: 'peer-a', total: 2 },
		]);
	});

	it('forces the `node` attribute into an explicit get_attributes list when replicated', async () => {
		global.server.nodes = [{ name: 'peer-a' }];
		sendOperationStub.resolves({ results: [] });

		await collect(await getOp({ metric: 'm', get_attributes: ['metric', 'total'], replicated: true }));

		const forwarded = sendOperationStub.firstCall.args[1];
		expect(forwarded.get_attributes).to.include('node');
	});

	it('does not fan out when `replicated` is not set', async () => {
		searchStub.returns(mockSearchIterable([{ id: [10, 1], metric: 'm', total: 1 }]));
		global.server.nodes = [{ name: 'peer-a' }];

		const result = await collect(await getOp({ metric: 'm', get_attributes: ['metric', 'total'] }));

		expect(sendOperationStub.called).to.be.false;
		expect(result).to.deep.equal([{ id: 10, metric: 'm', total: 1 }]);
	});

	it('does not fan out in standalone core (no server.nodes)', async () => {
		global.server.nodes = undefined;
		searchStub.returns(mockSearchIterable([{ id: [10, 1], metric: 'm' }]));

		const result = await collect(await getOp({ metric: 'm', get_attributes: ['metric'], replicated: true }));

		expect(sendOperationStub.called).to.be.false;
		expect(result).to.deep.equal([{ id: 10, metric: 'm' }]);
	});

	it('does not fan out when the analytics table already replicates (replicate !== false)', async () => {
		// `analytics_replicate: true` leaves the table `replicate` undefined; a local query
		// already holds every node's rows, so fanning out would double-count.
		delete global.databases.system.hdb_analytics.replicate;
		global.server.nodes = [{ name: 'peer-a' }];
		searchStub.returns(mockSearchIterable([{ id: [10, 1], metric: 'm', total: 1 }]));

		const result = await collect(await getOp({ metric: 'm', get_attributes: ['metric', 'total'], replicated: true }));

		expect(sendOperationStub.called).to.be.false;
		expect(result).to.deep.equal([{ id: 10, metric: 'm', total: 1 }]);
	});
});

describe('getOp (log filter)', () => {
	let searchStub;
	let originalDatabases;
	let originalServer;

	beforeEach(() => {
		originalDatabases = global.databases;
		originalServer = global.server;
		searchStub = sinon.stub().returns(mockSearchIterable([]));
		global.databases = { system: { hdb_analytics: { search: searchStub, replicate: true } } };
		global.server = { hostname: 'local-host', nodes: [] };
	});

	afterEach(() => {
		sinon.restore();
		global.databases = originalDatabases;
		global.server = originalServer;
	});

	it('adds a `log` equals condition when log is provided', async () => {
		await collect(await getOp({ metric: 'rocksdb-txnlog-stats', log: 'audit' }));

		const conditions = searchStub.firstCall.args[0].conditions;
		expect(conditions[0]).to.deep.equal({ attribute: 'metric', comparator: 'equals', value: 'rocksdb-txnlog-stats' });
		expect(conditions).to.deep.include({ attribute: 'log', comparator: 'equals', value: 'audit' });
	});

	it('does not add a `log` condition when log is omitted', async () => {
		await collect(await getOp({ metric: 'rocksdb-txnlog-stats' }));

		const conditions = searchStub.firstCall.args[0].conditions;
		expect(conditions.some((c) => c.attribute === 'log')).to.be.false;
	});

	it('rejects a `log` filter on a non-txnlog metric instead of silently returning nothing', async () => {
		let threw = false;
		try {
			await getOp({ metric: 'cpu-usage', log: 'audit' });
		} catch {
			threw = true;
		}
		expect(threw).to.be.true;
		expect(searchStub.called).to.be.false;
	});
});
