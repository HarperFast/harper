'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('cloneNode', () => {
	let cloneNode;
	let clusterStatusStub;
	let setStatusStub;
	let consoleLogStub;
	let consoleWarnStub;
	let consoleErrorStub;

	beforeEach(() => {
		// Stub console methods
		consoleLogStub = sinon.stub(console, 'log');
		consoleWarnStub = sinon.stub(console, 'warn');
		consoleErrorStub = sinon.stub(console, 'error');

		// Rewire the module to access private functions
		cloneNode = rewire('../../../utility/cloneNode/cloneNode.js');
		
		// Stub the external dependencies
		clusterStatusStub = sinon.stub().resolves({
			node_name: 'test-node',
			is_enabled: true,
			connections: []
		});
		
		setStatusStub = sinon.stub().resolves();
		
		// Replace the imported functions with our stubs
		cloneNode.__set__('clusterStatus', clusterStatusStub);
		cloneNode.__set__('setStatus', setStatusStub);
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('monitorSyncAndUpdateStatus', () => {
		let monitorSyncAndUpdateStatus;
		let clock;

		beforeEach(() => {
			monitorSyncAndUpdateStatus = cloneNode.__get__('monitorSyncAndUpdateStatus');
			clock = sinon.useFakeTimers();
		});

		afterEach(() => {
			clock.restore();
			delete process.env.CLONE_NODE_UPDATE_STATUS;
			delete process.env.HDB_CLONE_STATUS_ID;
			delete process.env.HDB_CLONE_SUCCESS_STATUS;
			delete process.env.HDB_CLONE_SYNC_TIMEOUT;
			delete process.env.HDB_CLONE_CHECK_INTERVAL;
		});

		it('should not run when CLONE_NODE_UPDATE_STATUS is not true', async () => {
			delete process.env.CLONE_NODE_UPDATE_STATUS;
			
			await monitorSyncAndUpdateStatus({ database1: 1234567890 });
			
			assert(clusterStatusStub.notCalled);
			assert(setStatusStub.notCalled);
			assert(consoleLogStub.calledWith('Clone node status update is disabled'));
		});

		it('should update status when sync is complete', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_CHECK_INTERVAL = '100'; // 100ms for faster test
			
			const targetTimestamps = { database1: 1234567890 };
			
			// Mock cluster status to show sync is complete
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [{
						database: 'database1',
						lastReceivedRemoteTime: new Date(1234567891) // Later than target
					}]
				}]
			});

			await monitorSyncAndUpdateStatus(targetTimestamps);
			
			assert(clusterStatusStub.called);
			assert(setStatusStub.calledOnceWith({ id: 'availability', status: 'Available' }));
			assert(consoleLogStub.calledWith('All databases synchronized, updating status'));
		});

		it('should use custom environment variables', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_STATUS_ID = 'custom-status';
			process.env.HDB_CLONE_SUCCESS_STATUS = 'Ready';
			process.env.HDB_CLONE_CHECK_INTERVAL = '100';
			
			const targetTimestamps = { database1: 1234567890 };
			
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [{
						database: 'database1',
						lastReceivedRemoteTime: new Date(1234567891)
					}]
				}]
			});

			await monitorSyncAndUpdateStatus(targetTimestamps);
			
			assert(setStatusStub.calledOnceWith({ id: 'custom-status', status: 'Ready' }));
		});

		it('should timeout when sync does not complete', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '200'; // 200ms timeout
			process.env.HDB_CLONE_CHECK_INTERVAL = '50'; // 50ms interval
			
			const targetTimestamps = { database1: 1234567890 };
			
			// Mock cluster status to show sync is never complete
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [{
						database: 'database1',
						lastReceivedRemoteTime: new Date(1234567889) // Earlier than target
					}]
				}]
			});

			const promise = monitorSyncAndUpdateStatus(targetTimestamps);
			
			// Advance time to trigger timeout
			await clock.tickAsync(250);
			await promise;
			
			assert(setStatusStub.notCalled);
			assert(consoleWarnStub.calledWith('Sync monitoring timed out after 200ms'));
		});

		it('should handle cluster status errors gracefully', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_CHECK_INTERVAL = '50';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '200';
			
			const targetTimestamps = { database1: 1234567890 };
			
			// First call fails, second succeeds
			clusterStatusStub.onFirstCall().rejects(new Error('Network error'));
			clusterStatusStub.onSecondCall().resolves({
				connections: [{
					database_sockets: [{
						database: 'database1',
						lastReceivedRemoteTime: new Date(1234567891)
					}]
				}]
			});

			const promise = monitorSyncAndUpdateStatus(targetTimestamps);
			
			// Advance time for first check (error)
			await clock.tickAsync(50);
			// Advance time for second check (success)
			await clock.tickAsync(50);
			
			await promise;
			
			assert(clusterStatusStub.calledTwice);
			assert(setStatusStub.calledOnce);
			assert(consoleErrorStub.calledWith('Error checking cluster status:', sinon.match.instanceOf(Error)));
		});
	});

	describe('checkSyncStatus', () => {
		let checkSyncStatus;

		beforeEach(() => {
			checkSyncStatus = cloneNode.__get__('checkSyncStatus');
		});

		it('should return true when no target timestamps', () => {
			const result = checkSyncStatus({ connections: [] }, null);
			assert.strictEqual(result, true);
		});

		it('should return true when empty target timestamps', () => {
			const result = checkSyncStatus({ connections: [] }, {});
			assert.strictEqual(result, true);
		});

		it('should return true when all databases are synchronized', () => {
			const clusterResponse = {
				connections: [{
					database_sockets: [
						{
							database: 'db1',
							lastReceivedRemoteTime: new Date('2024-01-01T12:00:00Z')
						},
						{
							database: 'db2',
							lastReceivedRemoteTime: new Date('2024-01-01T12:00:00Z')
						}
					]
				}]
			};
			
			const targetTimestamps = {
				db1: new Date('2024-01-01T11:59:59Z').getTime(),
				db2: new Date('2024-01-01T11:59:59Z').getTime()
			};
			
			const result = checkSyncStatus(clusterResponse, targetTimestamps);
			assert.strictEqual(result, true);
		});

		it('should return false when database has no received time', () => {
			const clusterResponse = {
				connections: [{
					database_sockets: [{
						database: 'db1',
						lastReceivedRemoteTime: null
					}]
				}]
			};
			
			const targetTimestamps = {
				db1: new Date('2024-01-01T12:00:00Z').getTime()
			};
			
			const result = checkSyncStatus(clusterResponse, targetTimestamps);
			assert.strictEqual(result, false);
		});

		it('should return false when database is not yet synchronized', () => {
			const clusterResponse = {
				connections: [{
					database_sockets: [{
						database: 'db1',
						lastReceivedRemoteTime: new Date('2024-01-01T11:00:00Z')
					}]
				}]
			};
			
			const targetTimestamps = {
				db1: new Date('2024-01-01T12:00:00Z').getTime()
			};
			
			const result = checkSyncStatus(clusterResponse, targetTimestamps);
			assert.strictEqual(result, false);
		});

		it('should skip databases not in target timestamps', () => {
			const clusterResponse = {
				connections: [{
					database_sockets: [
						{
							database: 'db1',
							lastReceivedRemoteTime: new Date('2024-01-01T12:00:00Z')
						},
						{
							database: 'db2',
							lastReceivedRemoteTime: null // This would normally fail
						}
					]
				}]
			};
			
			const targetTimestamps = {
				db1: new Date('2024-01-01T11:00:00Z').getTime()
				// db2 is not included, so it should be skipped
			};
			
			const result = checkSyncStatus(clusterResponse, targetTimestamps);
			assert.strictEqual(result, true);
		});
	});
});