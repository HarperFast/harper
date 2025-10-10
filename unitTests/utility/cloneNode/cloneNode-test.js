'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('cloneNode', () => {
	let cloneNode;
	let clusterStatusStub;
	let setStatusStub;
	let consoleLogStub;
	let consoleErrorStub;

	beforeEach(() => {
		// Stub console methods
		consoleLogStub = sinon.stub(console, 'log');
		consoleErrorStub = sinon.stub(console, 'error');

		// Rewire the module to access private functions
		cloneNode = rewire('../../../utility/cloneNode/cloneNode.js');

		// Stub the external dependencies
		clusterStatusStub = sinon.stub().resolves({
			node_name: 'test-node',
			is_enabled: true,
			connections: [],
		});

		setStatusStub = sinon.stub().resolves();

		// Replace the imported functions with our stubs
		cloneNode.__set__('clusterStatus', clusterStatusStub);
		cloneNode.__set__('setStatus', setStatusStub);
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('isStatusUpdateEnabled', () => {
		let isStatusUpdateEnabled;

		beforeEach(() => {
			isStatusUpdateEnabled = cloneNode.__get__('isStatusUpdateEnabled');
		});

		afterEach(() => {
			delete process.env.CLONE_NODE_UPDATE_STATUS;
		});

		it('should return true when CLONE_NODE_UPDATE_STATUS is true', () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			assert.strictEqual(isStatusUpdateEnabled(), true);
		});

		it('should return false when CLONE_NODE_UPDATE_STATUS is not true', () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'false';
			assert.strictEqual(isStatusUpdateEnabled(), false);
		});

		it('should return false when CLONE_NODE_UPDATE_STATUS is not set', () => {
			delete process.env.CLONE_NODE_UPDATE_STATUS;
			assert.strictEqual(isStatusUpdateEnabled(), false);
		});
	});

	describe('isSystemDatabaseOnlySync', () => {
		let isSystemDatabaseOnlySync;

		beforeEach(() => {
			isSystemDatabaseOnlySync = cloneNode.__get__('isSystemDatabaseOnlySync');
		});

		afterEach(() => {
			delete process.env.CLONE_NODE_SYSTEM_DB_ONLY;
		});

		it('should return true when CLONE_NODE_SYSTEM_DB_ONLY is true', () => {
			process.env.CLONE_NODE_SYSTEM_DB_ONLY = 'true';
			assert.strictEqual(isSystemDatabaseOnlySync(), true);
		});

		it('should return false when CLONE_NODE_SYSTEM_DB_ONLY is not true', () => {
			process.env.CLONE_NODE_SYSTEM_DB_ONLY = 'false';
			assert.strictEqual(isSystemDatabaseOnlySync(), false);
		});

		it('should return false when CLONE_NODE_SYSTEM_DB_ONLY is not set', () => {
			delete process.env.CLONE_NODE_SYSTEM_DB_ONLY;
			assert.strictEqual(isSystemDatabaseOnlySync(), false);
		});
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
			delete process.env.HDB_CLONE_SYNC_TIMEOUT;
			delete process.env.HDB_CLONE_CHECK_INTERVAL;
		});

		it('should monitor sync but not update status when CLONE_NODE_UPDATE_STATUS is not true', async () => {
			delete process.env.CLONE_NODE_UPDATE_STATUS;
			process.env.HDB_CLONE_CHECK_INTERVAL = '100';

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock cluster status to show sync is complete
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								lastReceivedRemoteTime: new Date(1234567891.8456).toUTCString(),
								lastReceivedVersion: 1234567891.8456,
							},
						],
					},
				],
			});

			await monitorSyncAndUpdateStatus(targetTimestamps);

			assert(clusterStatusStub.called);
			assert(setStatusStub.notCalled); // Should not update status
			assert(consoleLogStub.calledWith('All databases synchronized'));
		});

		it('should update status when sync is complete', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_CHECK_INTERVAL = '100'; // 100ms for faster test

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock cluster status to show sync is complete
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								lastReceivedRemoteTime: new Date(1234567891.8456).toUTCString(),
								lastReceivedVersion: 1234567891.8456, // Later than target
							},
						],
					},
				],
			});

			await monitorSyncAndUpdateStatus(targetTimestamps);

			assert(clusterStatusStub.called);
			assert(setStatusStub.calledOnceWith({ id: 'availability', status: 'Available' }));
			assert(consoleLogStub.calledWith('All databases synchronized'));
		});

		it('should throw error when sync times out', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '200'; // 200ms timeout
			process.env.HDB_CLONE_CHECK_INTERVAL = '50'; // 50ms interval

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock cluster status to show sync is never complete
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								lastReceivedRemoteTime: new Date(1234567889.1234).toUTCString(), // Earlier than target
								lastReceivedVersion: 1234567889.1234,
							},
						],
					},
				],
			});

			const promise = monitorSyncAndUpdateStatus(targetTimestamps);

			// Advance time to trigger timeout
			await clock.tickAsync(250);

			await assert.rejects(promise, {
				name: 'CloneSyncError',
				message: 'Sync monitoring timed out after 200ms',
			});

			assert(setStatusStub.notCalled);
		});

		it('should handle cluster status errors gracefully', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_CHECK_INTERVAL = '50';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '200';

			const targetTimestamps = { database1: 1234567890.5678 };

			// First call fails, second succeeds
			clusterStatusStub.onFirstCall().rejects(new Error('Network error'));
			clusterStatusStub.onSecondCall().resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								lastReceivedRemoteTime: new Date(1234567891.8456).toUTCString(),
								lastReceivedVersion: 1234567891.8456,
							},
						],
					},
				],
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

		it('should throw CloneSyncError when no target timestamps available', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';

			// Test with null timestamps
			await assert.rejects(async () => await monitorSyncAndUpdateStatus(null), {
				name: 'CloneSyncError',
				message: 'No target timestamps available to check synchronization status',
			});

			// Test with empty timestamps
			await assert.rejects(async () => await monitorSyncAndUpdateStatus({}), {
				name: 'CloneSyncError',
				message: 'No target timestamps available to check synchronization status',
			});

			// Should not have called cluster status since validation fails early
			assert(clusterStatusStub.notCalled);
			assert(setStatusStub.notCalled);
		});

		it('should enforce minimum 1ms values for time configuration', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '0'; // Invalid, should become 1
			process.env.HDB_CLONE_CHECK_INTERVAL = '-100'; // Invalid, should become 1

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock immediate sync completion
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								lastReceivedRemoteTime: new Date(1234567891.8456).toUTCString(),
								lastReceivedVersion: 1234567891.8456,
							},
						],
					},
				],
			});

			await monitorSyncAndUpdateStatus(targetTimestamps);

			// Should complete successfully with minimum values
			assert(clusterStatusStub.called);
			assert(setStatusStub.called);

			// Clean up
			delete process.env.HDB_CLONE_SYNC_TIMEOUT;
			delete process.env.HDB_CLONE_CHECK_INTERVAL;
		});

		it('should handle NaN environment values with defaults', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_SYNC_TIMEOUT = 'not-a-number';
			process.env.HDB_CLONE_CHECK_INTERVAL = 'invalid';

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock immediate sync completion
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								lastReceivedRemoteTime: new Date(1234567891.8456).toUTCString(),
								lastReceivedVersion: 1234567891.8456,
							},
						],
					},
				],
			});

			await monitorSyncAndUpdateStatus(targetTimestamps);

			// Should complete successfully with default values (300000ms and 10000ms)
			assert(clusterStatusStub.called);
			assert(setStatusStub.called);

			// Clean up
			delete process.env.HDB_CLONE_SYNC_TIMEOUT;
			delete process.env.HDB_CLONE_CHECK_INTERVAL;
		});
	});

	describe('checkSyncStatus', () => {
		let checkSyncStatus;

		beforeEach(() => {
			checkSyncStatus = cloneNode.__get__('checkSyncStatus');
		});

		it('should return true when no target timestamps', async () => {
			clusterStatusStub.resolves({ connections: [] });
			const result = await checkSyncStatus(null);
			assert.strictEqual(result, true);
		});

		it('should return true when empty target timestamps', async () => {
			clusterStatusStub.resolves({ connections: [] });
			const result = await checkSyncStatus({});
			assert.strictEqual(result, true);
		});

		it('should return true when all databases are synchronized', async () => {
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'db1',
								lastReceivedRemoteTime: new Date('2024-01-01T12:00:00Z'),
								lastReceivedVersion: new Date('2024-01-01T12:00:00Z').getTime(),
							},
							{
								database: 'db2',
								lastReceivedRemoteTime: new Date('2024-01-01T12:00:00Z'),
								lastReceivedVersion: new Date('2024-01-01T12:00:00Z').getTime(),
							},
						],
					},
				],
			});

			const targetTimestamps = {
				db1: new Date('2024-01-01T11:59:59Z').getTime(),
				db2: new Date('2024-01-01T11:59:59Z').getTime(),
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, true);
		});

		it('should return false when database has no received time', async () => {
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'db1',
								lastReceivedRemoteTime: null,
								lastReceivedVersion: null,
							},
						],
					},
				],
			});

			const targetTimestamps = {
				db1: new Date('2024-01-01T12:00:00Z').getTime(),
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, false);
		});

		it('should return false when database is not yet synchronized', async () => {
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'db1',
								lastReceivedRemoteTime: new Date('2024-01-01T11:00:00Z'),
								lastReceivedVersion: new Date('2024-01-01T11:00:00Z').getTime(),
							},
						],
					},
				],
			});

			const targetTimestamps = {
				db1: new Date('2024-01-01T12:00:00Z').getTime(),
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, false);
		});

		it('should skip databases not in target timestamps', async () => {
			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'db1',
								lastReceivedRemoteTime: new Date('2024-01-01T12:00:00Z'),
								lastReceivedVersion: new Date('2024-01-01T12:00:00Z').getTime(),
							},
							{
								database: 'db2',
								lastReceivedRemoteTime: null,
								lastReceivedVersion: null, // This would normally fail
							},
						],
					},
				],
			});

			const targetTimestamps = {
				db1: new Date('2024-01-01T11:00:00Z').getTime(),
				// db2 is not included, so it should be skipped
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, true);
			assert(consoleLogStub.calledWith('Database db2: No target timestamp, skipping sync check'));
		});

		it('should handle sub-millisecond precision correctly (precision loss test)', async () => {
			// This test would fail before the precision fix
			// Target has sub-millisecond precision, received version matches exactly
			const targetTime = 1757517636009.8606; // High precision target (safe float64)
			const receivedVersion = 1757517636009.8606; // Exact match with sub-millisecond precision

			clusterStatusStub.resolves({
				connections: [
					{
						database_sockets: [
							{
								database: 'database1',
								// The UTC string loses sub-millisecond precision (truncated to 1757517636009)
								lastReceivedRemoteTime: new Date(receivedVersion).toUTCString(),
								// But the raw version preserves full precision (1757517636009.8606)
								lastReceivedVersion: receivedVersion,
							},
						],
					},
				],
			});

			const targetTimestamps = { database1: targetTime };
			const result = await checkSyncStatus(targetTimestamps);

			// Should be synchronized because raw versions match exactly
			assert.strictEqual(result, true);
		});
	});

	describe('checkSyncStatus with enhanced cluster status responses', () => {
		let checkSyncStatus;

		beforeEach(() => {
			checkSyncStatus = cloneNode.__get__('checkSyncStatus');
		});

		it('should handle cluster response with enhanced replication data', async () => {
			// Mock clusterStatus to return enhanced response with replication data
			clusterStatusStub.resolves({
				connections: [{
					name: 'remote-node',
					database_sockets: [{
						database: 'testdb',
						connected: true,
						latency: 50,
						// Enhanced replication data
						lastReceivedVersion: 1234567890123.456,
						lastReceivedRemoteTime: new Date(1234567890123.456).toUTCString(),
						lastCommitConfirmed: new Date(1234567890120.0).toUTCString(),
						backPressurePercent: 10.5,
						lastReceivedStatus: 'Waiting'
					}]
				}]
			});

			const targetTimestamps = { testdb: 1234567890000.0 };
			const result = await checkSyncStatus(targetTimestamps);

			// Should call cluster status
			assert(clusterStatusStub.called);

			// Should return true since received version (1234567890123.456) > target (1234567890000.0)
			assert.strictEqual(result, true);
		});

		it('should handle cluster response without lastReceivedVersion', async () => {
			// Mock cluster response missing the enhanced replication data
			clusterStatusStub.resolves({
				connections: [{
					name: 'remote-node',
					database_sockets: [{
						database: 'testdb',
						connected: true,
						latency: 50
						// Missing lastReceivedVersion - should be undefined
					}]
				}]
			});

			const targetTimestamps = { testdb: 1234567890000.0 };
			const result = await checkSyncStatus(targetTimestamps);

			// Should return false since no lastReceivedVersion means no data received yet
			assert.strictEqual(result, false);
			assert(consoleLogStub.calledWith('Database testdb: No data received yet'));
		});

		it('should handle multiple databases with mixed sync status', async () => {
			clusterStatusStub.resolves({
				connections: [{
					name: 'remote-node',
					database_sockets: [
						{
							database: 'db1',
							lastReceivedVersion: 1234567891000.0 // Synced
						},
						{
							database: 'db2',
							lastReceivedVersion: 1234567889000.0 // Behind
						},
						{
							database: 'db3' // Missing lastReceivedVersion
						}
					]
				}]
			});

			const targetTimestamps = {
				db1: 1234567890000.0, // Should be synced
				db2: 1234567890000.0, // Should be behind
				db3: 1234567890000.0  // Should be missing
			};

			const result = await checkSyncStatus(targetTimestamps);

			// Should return false because db2 is behind and db3 has no data
			assert.strictEqual(result, false);
		});

		it('should handle connection with undefined database_sockets', async () => {
			clusterStatusStub.resolves({
				connections: [{
					name: 'remote-node',
					database_sockets: undefined
				}]
			});

			const targetTimestamps = { testdb: 1234567890000.0 };
			const result = await checkSyncStatus(targetTimestamps);

			// Should return true since no database_sockets to check
			assert.strictEqual(result, true);
			assert(consoleLogStub.calledWith('Connection remote-node: No database_sockets, skipping'));
		});

		it('should handle cluster status with backPressurePercent and status info', async () => {
			clusterStatusStub.resolves({
				connections: [{
					name: 'remote-node',
					database_sockets: [{
						database: 'testdb',
						connected: true,
						latency: 25,
						lastReceivedVersion: 1234567891000.0,
						lastReceivedRemoteTime: new Date(1234567891000.0).toUTCString(),
						lastCommitConfirmed: new Date(1234567890000.0).toUTCString(),
						backPressurePercent: 25.5,
						lastReceivedStatus: 'Receiving'
					}]
				}]
			});

			const targetTimestamps = { testdb: 1234567890000.0 };
			const result = await checkSyncStatus(targetTimestamps);

			// Should be synchronized
			assert.strictEqual(result, true);
			assert(consoleLogStub.calledWith('Database testdb: Synchronized'));
		});
	});

	describe('checkSyncStatus with systemDatabaseOnly parameter', () => {
		let checkSyncStatus;
		let SYSTEM_SCHEMA_NAME;

		beforeEach(() => {
			checkSyncStatus = cloneNode.__get__('checkSyncStatus');
			// Get the SYSTEM_SCHEMA_NAME constant from the module
			const hdbTerms = cloneNode.__get__('hdbTerms');
			SYSTEM_SCHEMA_NAME = hdbTerms.SYSTEM_SCHEMA_NAME;
		});

		it('should check all databases when systemDatabaseOnly is false', async () => {
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [
						{
							database: SYSTEM_SCHEMA_NAME,
							lastReceivedVersion: 1234567891000.0
						},
						{
							database: 'userdb',
							lastReceivedVersion: 1234567891000.0
						}
					]
				}]
			});

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, false);

			// Should check both databases and return true (both synced)
			assert.strictEqual(result, true);
			assert(consoleLogStub.calledWith(`Database ${SYSTEM_SCHEMA_NAME}: Synchronized`));
			assert(consoleLogStub.calledWith('Database userdb: Synchronized'));
		});

		it('should only check system database when systemDatabaseOnly is true', async () => {
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [
						{
							database: SYSTEM_SCHEMA_NAME,
							lastReceivedVersion: 1234567891000.0
						},
						{
							database: 'userdb',
							lastReceivedVersion: 1234567889000.0 // Behind, but should be skipped
						}
					]
				}]
			});

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, true);

			// Should only check system database and return true (system synced, userdb skipped)
			assert.strictEqual(result, true);
			assert(consoleLogStub.calledWith(`Database ${SYSTEM_SCHEMA_NAME}: Synchronized`));
			assert(consoleLogStub.calledWith('Database userdb: Skipping (waiting for system database only)'));
			assert(consoleLogStub.neverCalledWith('Database userdb: Synchronized'));
		});

		it('should return false if system database is not synced when systemDatabaseOnly is true', async () => {
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [
						{
							database: SYSTEM_SCHEMA_NAME,
							lastReceivedVersion: 1234567889000.0 // Behind
						},
						{
							database: 'userdb',
							lastReceivedVersion: 1234567891000.0 // Synced but should be skipped
						}
					]
				}]
			});

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, true);

			// Should return false because system database is not synced
			assert.strictEqual(result, false);
			assert(consoleLogStub.calledWithMatch(`Database ${SYSTEM_SCHEMA_NAME}: Not yet synchronized`));
		});

		it('should return false if user database is not synced when systemDatabaseOnly is false', async () => {
			clusterStatusStub.resolves({
				connections: [{
					database_sockets: [
						{
							database: SYSTEM_SCHEMA_NAME,
							lastReceivedVersion: 1234567891000.0 // Synced
						},
						{
							database: 'userdb',
							lastReceivedVersion: 1234567889000.0 // Behind
						}
					]
				}]
			});

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, false);

			// Should return false because userdb is not synced
			assert.strictEqual(result, false);
			assert(consoleLogStub.calledWithMatch('Database userdb: Not yet synchronized'));
		});
	});
});
