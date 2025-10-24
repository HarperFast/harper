import assert from 'node:assert/strict';
import sinon from 'sinon';
import { CrossThreadStatusCollector, StatusAggregator } from '@/components/status/crossThread';
import { ComponentStatusRegistry } from '@/components/status/ComponentStatusRegistry';

describe('CrossThread Module', function () {
	let sendItcEventStub;
	let onMessageByTypeStub;
	let getWorkerIndexStub;
	let itcModule;
	let manageThreadsModule;

	beforeEach(function () {
		// Stub ITC functions
		itcModule = require('@/server/threads/itc');
		manageThreadsModule = require('@/server/threads/manageThreads');
		sendItcEventStub = sinon.stub(itcModule, 'sendItcEvent').resolves();
		onMessageByTypeStub = sinon.stub(manageThreadsModule, 'onMessageByType');
		getWorkerIndexStub = sinon.stub(manageThreadsModule, 'getWorkerIndex').returns(0);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('CrossThreadStatusCollector', function () {
		let collector;
		let registry;

		beforeEach(function () {
			collector = new CrossThreadStatusCollector(1000); // 1 second timeout
			registry = new ComponentStatusRegistry();
		});

		afterEach(function () {
			collector.cleanup();
			registry.reset();
		});

		it('should collect status from local thread only when no responses', async function () {
			registry.setStatus('localComp', 'healthy', 'All good');
			// Test with main thread (undefined)
			getWorkerIndexStub.returns(undefined);

			// Mock getWorkerCount
			const getWorkerCountStub = sinon.stub(manageThreadsModule, 'getWorkerCount').returns(2);

			// Simulate no responses from other threads
			onMessageByTypeStub.callsFake(() => {});

			const collected = await collector.collect(registry);

			assert.equal(collected.size, 1);
			assert.ok(collected.has('localComp@main'));
			assert.equal(collected.get('localComp@main').status, 'healthy');

			// Cleanup
			getWorkerCountStub.restore();
		});

		it('should collect status from multiple threads', async function () {
			this.timeout(5000); // Allow enough time for async operations
			registry.setStatus('sharedComp', 'healthy', 'Local is healthy');
			// Test with main thread (undefined)
			getWorkerIndexStub.returns(undefined);

			// Mock getWorkerCount
			const getWorkerCountStub = sinon.stub(manageThreadsModule, 'getWorkerCount').returns(2);

			// Simulate responses from other threads
			onMessageByTypeStub.callsFake((eventType, handler) => {
				// Simulate async responses
				setTimeout(() => {
					handler({
						message: {
							requestId: 1,
							workerIndex: 1,
							isMainThread: false,
							statuses: [
								[
									'sharedComp',
									{
										status: 'warning',
										message: 'Worker 1 warning',
										lastChecked: new Date(),
									},
								],
							],
						},
					});
					handler({
						message: {
							requestId: 1,
							workerIndex: 2,
							isMainThread: false,
							statuses: [
								[
									'sharedComp',
									{
										status: 'healthy',
										message: 'Worker 2 healthy',
										lastChecked: new Date(),
									},
								],
							],
						},
					});
				}, 100);
			});

			// Wait for collection to complete
			const collected = await collector.collect(registry);

			assert.equal(collected.size, 3);
			// In test environment with undefined workerIndex, we get main thread
			assert.ok(collected.has('sharedComp@main'));
			assert.ok(collected.has('sharedComp@worker-1'));
			assert.ok(collected.has('sharedComp@worker-2'));

			// Cleanup
			getWorkerCountStub.restore();
		});

		it('should handle ITC send failure', async function () {
			registry.setStatus('fallbackComp', 'error', 'Local error');
			// Test with main thread (undefined)
			getWorkerIndexStub.returns(undefined);

			// Mock getWorkerCount
			const getWorkerCountStub = sinon.stub(manageThreadsModule, 'getWorkerCount').returns(2);

			// Make sendItcEvent reject
			sendItcEventStub.rejects(new Error('ITC failure'));

			const collected = await collector.collect(registry);

			// Should fallback to local status only
			assert.equal(collected.size, 1);
			// In test environment with undefined workerIndex, we get main thread
			assert.ok(collected.has('fallbackComp@main'));
			assert.equal(collected.get('fallbackComp@main').status, 'error');

			// Cleanup
			getWorkerCountStub.restore();
		});

		it('should handle collection timeout', async function () {
			this.timeout(5000);
			const shortTimeoutCollector = new CrossThreadStatusCollector(50); // Very short timeout
			registry.setStatus('timeoutComp', 'loading', 'Loading...');
			// Test with main thread (undefined)
			getWorkerIndexStub.returns(undefined);

			// Mock getWorkerCount
			const getWorkerCountStub = sinon.stub(manageThreadsModule, 'getWorkerCount').returns(2);

			// Never send responses
			onMessageByTypeStub.callsFake(() => {});

			const collected = await shortTimeoutCollector.collect(registry);

			// Should only have local status due to timeout
			assert.equal(collected.size, 1);
			assert.ok(collected.has('timeoutComp@main'));

			shortTimeoutCollector.cleanup();
			getWorkerCountStub.restore();
		});

		it('should complete early when all threads respond', async function () {
			this.timeout(5000);
			registry.setStatus('fastComp', 'healthy', 'Main thread');
			getWorkerIndexStub.returns(0);

			// Mock getWorkerCount to return 2 (expecting 2 worker responses)
			const manageThreadsModule = require('@/server/threads/manageThreads');
			const getWorkerCountStub = sinon.stub(manageThreadsModule, 'getWorkerCount').returns(2);

			// Track when collection completes
			const startTime = Date.now();
			let resolveTime;

			sendItcEventStub.resolves();

			// Setup response handler to send responses quickly
			onMessageByTypeStub.callsFake((eventType, handler) => {
				// Send responses after just 50ms (much less than 5000ms timeout)
				setTimeout(() => {
					handler({
						message: {
							requestId: 1,
							workerIndex: 1,
							isMainThread: false,
							statuses: [['fastComp', { status: 'healthy' }]],
						},
					});
					// Second response completes the set
					handler({
						message: {
							requestId: 1,
							workerIndex: 2,
							isMainThread: false,
							statuses: [['fastComp', { status: 'healthy' }]],
						},
					});
				}, 50);
			});

			const collected = await collector.collect(registry);
			resolveTime = Date.now() - startTime;

			// Should complete much faster than timeout
			assert.ok(resolveTime < 1000, `Collection took ${resolveTime}ms, should be < 1000ms`);
			assert.equal(collected.size, 3); // local + 2 workers

			// Cleanup the stub
			getWorkerCountStub.restore();
		});

		it('should reuse listener across multiple collections', async function () {
			// First collection
			await collector.collect(registry);
			assert.equal(onMessageByTypeStub.callCount, 1);

			// Second collection - should not attach listener again
			await collector.collect(registry);
			assert.equal(onMessageByTypeStub.callCount, 1);
		});

		it('should properly clean up resources', function () {
			// Set up some pending requests
			collector['awaitingResponses'].set(1, []);
			collector['awaitingResponses'].set(2, []);

			// Set a cleanup timer
			collector['cleanupTimer'] = setTimeout(() => {}, 10000);

			// Call cleanup
			collector.cleanup();

			// Verify everything is cleaned up
			assert.equal(collector['awaitingResponses'].size, 0);
			assert.equal(collector['cleanupTimer'], null);
		});
	});

	describe('StatusAggregator', function () {
		let clock;

		beforeEach(function () {
			clock = sinon.useFakeTimers();
		});

		afterEach(function () {
			clock.restore();
		});

		it('should aggregate single component from single thread', function () {
			const allStatuses = new Map([
				[
					'database@worker-0',
					{
						status: 'healthy',
						lastChecked: new Date(1000),
						message: 'Database running',
					},
				],
			]);

			const aggregated = StatusAggregator.aggregate(allStatuses);

			assert.equal(aggregated.size, 1);
			const aggStatus = aggregated.get('database');
			assert.ok(aggStatus);
			assert.equal(aggStatus.componentName, 'database');
			assert.equal(aggStatus.status, 'healthy');
			assert.equal(aggStatus.latestMessage, undefined); // Healthy messages not included
			assert.equal(aggStatus.lastChecked.workers[0], 1000);
			assert.equal(aggStatus.abnormalities, undefined);
		});

		it('should detect abnormalities when statuses differ', function () {
			const allStatuses = new Map([
				[
					'api@worker-0',
					{
						status: 'healthy',
						lastChecked: new Date(1000),
						message: 'Worker 0 healthy',
					},
				],
				[
					'api@worker-1',
					{
						status: 'error',
						lastChecked: new Date(2000),
						message: 'Connection failed',
						error: 'Timeout',
					},
				],
				[
					'api@worker-2',
					{
						status: 'healthy',
						lastChecked: new Date(3000),
						message: 'Worker 2 healthy',
					},
				],
			]);

			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('api');

			assert.equal(aggStatus.status, 'error'); // Error takes priority
			assert.ok(aggStatus.abnormalities);
			assert.equal(aggStatus.abnormalities.size, 2); // Two healthy threads are abnormal

			// Check abnormality details
			const worker0Abnormality = aggStatus.abnormalities.get('api@worker-0');
			assert.ok(worker0Abnormality);
			assert.equal(worker0Abnormality.status, 'healthy');
			assert.equal(worker0Abnormality.workerIndex, -1); // No workerIndex in input
		});

		it('should prioritize non-healthy messages', function () {
			const allStatuses = new Map([
				[
					'service@worker-0',
					{
						status: 'healthy',
						lastChecked: new Date(3000), // Most recent
						message: 'All systems operational',
					},
				],
				[
					'service@worker-1',
					{
						status: 'warning',
						lastChecked: new Date(2000),
						message: 'High latency detected',
					},
				],
				[
					'service@worker-2',
					{
						status: 'healthy',
						lastChecked: new Date(1000),
						message: 'Running normally',
					},
				],
			]);

			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('service');

			assert.equal(aggStatus.status, 'warning');
			assert.equal(aggStatus.latestMessage, 'High latency detected'); // Non-healthy message preferred
		});

		it('should handle status priority correctly', function () {
			const testCases = [
				{ statuses: ['healthy', 'healthy', 'healthy'], expected: 'healthy' },
				{ statuses: ['healthy', 'unknown', 'healthy'], expected: 'unknown' },
				{ statuses: ['healthy', 'loading', 'unknown'], expected: 'loading' },
				{ statuses: ['healthy', 'warning', 'loading'], expected: 'warning' },
				{ statuses: ['healthy', 'error', 'warning'], expected: 'error' },
			];

			for (const testCase of testCases) {
				const statuses = new Map();
				testCase.statuses.forEach((status, i) => {
					statuses.set(`comp@worker-${i}`, {
						status,
						lastChecked: new Date(i * 1000),
					});
				});

				const aggregated = StatusAggregator.aggregate(statuses);
				const aggStatus = aggregated.get('comp');
				assert.equal(aggStatus.status, testCase.expected);
			}
		});

		it('should handle main thread correctly', function () {
			const allStatuses = new Map([
				[
					'logger@main',
					{
						status: 'healthy',
						lastChecked: new Date(1000),
						message: 'Main thread logger',
					},
				],
				[
					'logger@worker-1',
					{
						status: 'healthy',
						lastChecked: new Date(2000),
						message: 'Worker 1 logger',
					},
				],
			]);

			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('logger');

			assert.equal(aggStatus.lastChecked.main, 1000);
			assert.equal(aggStatus.lastChecked.workers[1], 2000);
		});

		it('should handle worker index in status data', function () {
			const allStatuses = new Map([
				[
					'cache@worker-1',
					{
						status: 'error',
						lastChecked: new Date(1000),
						message: 'Failed',
						workerIndex: 1,
					},
				],
				[
					'cache@worker-2',
					{
						status: 'healthy',
						lastChecked: new Date(2000),
						message: 'OK',
						workerIndex: 2,
					},
				],
			]);

			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('cache');

			// Check abnormalities have correct worker index
			const abnormality = aggStatus.abnormalities.get('cache@worker-2');
			assert.equal(abnormality.workerIndex, 2);
		});
	});
});
