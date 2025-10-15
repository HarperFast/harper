'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('cloneNode', () => {
	let cloneNode;
	let setStatusStub;
	let loggerStub;

	beforeEach(() => {
		// Rewire the module to access private functions
		cloneNode = rewire('../../../utility/cloneNode/cloneNode.js');

		// Stub the logger with all logger methods
		loggerStub = {
			info: sinon.stub(),
			debug: sinon.stub(),
			notify: sinon.stub(),
			error: sinon.stub(),
			warn: sinon.stub(),
		};

		setStatusStub = sinon.stub().resolves();

		// Replace the imported functions with our stubs
		cloneNode.__set__('setStatus', setStatusStub);
		cloneNode.__set__('logger', loggerStub);
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
		let databasesStub;

		beforeEach(() => {
			monitorSyncAndUpdateStatus = cloneNode.__get__('monitorSyncAndUpdateStatus');
			clock = sinon.useFakeTimers();
			databasesStub = {};
			cloneNode.__set__('databases', databasesStub);
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

			// Mock local database with synced data
			databasesStub.database1 = {
				table1: { last_updated_record: 1234567891.8456 }
			};

			await monitorSyncAndUpdateStatus(targetTimestamps);

			assert(setStatusStub.notCalled); // Should not update status
			assert(loggerStub.notify.calledWith('All databases synchronized'));
		});

		it('should update status when sync is complete', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_CHECK_INTERVAL = '100'; // 100ms for faster test

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock local database with synced data
			databasesStub.database1 = {
				table1: { last_updated_record: 1234567891.8456 }
			};

			await monitorSyncAndUpdateStatus(targetTimestamps);

			assert(setStatusStub.calledOnceWith({ id: 'availability', status: 'Available' }));
			assert(loggerStub.notify.calledWith('All databases synchronized'));
		});

		it('should throw error when sync times out', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '200'; // 200ms timeout
			process.env.HDB_CLONE_CHECK_INTERVAL = '50'; // 50ms interval

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock local database with data that never catches up
			databasesStub.database1 = {
				table1: { last_updated_record: 1234567889.1234 } // Earlier than target
			};

			const promise = monitorSyncAndUpdateStatus(targetTimestamps);

			// Advance time to trigger timeout
			await clock.tickAsync(250);

			await assert.rejects(promise, {
				name: 'CloneSyncError',
				message: 'Sync monitoring timed out after 200ms',
			});

			assert(setStatusStub.notCalled);
		});

		it('should handle sync check errors gracefully', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_CHECK_INTERVAL = '50';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '200';

			const targetTimestamps = { database1: 1234567890.5678 };

			// First check: database doesn't exist (will skip and return true, but we can simulate an error differently)
			// Let's make it not synced first, then synced
			databasesStub.database1 = {
				table1: { last_updated_record: 1234567889.0 } // Behind at first
			};

			const promise = monitorSyncAndUpdateStatus(targetTimestamps);

			// Advance time for first check (not synced)
			await clock.tickAsync(50);

			// Update database to be synced
			databasesStub.database1.table1.last_updated_record = 1234567891.8456;

			// Advance time for second check (success)
			await clock.tickAsync(50);

			await promise;

			assert(setStatusStub.calledOnce);
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

			assert(setStatusStub.notCalled);
		});

		it('should enforce minimum 1ms values for time configuration', async () => {
			process.env.CLONE_NODE_UPDATE_STATUS = 'true';
			process.env.HDB_CLONE_SYNC_TIMEOUT = '0'; // Invalid, should become 1
			process.env.HDB_CLONE_CHECK_INTERVAL = '-100'; // Invalid, should become 1

			const targetTimestamps = { database1: 1234567890.5678 };

			// Mock immediate sync completion
			databasesStub.database1 = {
				table1: { last_updated_record: 1234567891.8456 }
			};

			await monitorSyncAndUpdateStatus(targetTimestamps);

			// Should complete successfully with minimum values
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
			databasesStub.database1 = {
				table1: { last_updated_record: 1234567891.8456 }
			};

			await monitorSyncAndUpdateStatus(targetTimestamps);

			// Should complete successfully with default values (300000ms and 10000ms)
			assert(setStatusStub.called);

			// Clean up
			delete process.env.HDB_CLONE_SYNC_TIMEOUT;
			delete process.env.HDB_CLONE_CHECK_INTERVAL;
		});
	});

	describe('checkSyncStatus', () => {
		let checkSyncStatus;
		let databasesStub;

		beforeEach(() => {
			checkSyncStatus = cloneNode.__get__('checkSyncStatus');
			databasesStub = {};
			cloneNode.__set__('databases', databasesStub);
		});

		it('should return true when no target timestamps', async () => {
			const result = await checkSyncStatus(null);
			assert.strictEqual(result, true);
		});

		it('should return true when empty target timestamps', async () => {
			const result = await checkSyncStatus({});
			assert.strictEqual(result, true);
		});

		it('should return true when all databases are synchronized', async () => {
			// Mock databases with tables that have last_updated_record
			databasesStub.db1 = {
				table1: { last_updated_record: new Date('2024-01-01T12:00:00Z').getTime() },
				table2: { last_updated_record: new Date('2024-01-01T11:30:00Z').getTime() }
			};
			databasesStub.db2 = {
				table1: { last_updated_record: new Date('2024-01-01T12:00:00Z').getTime() }
			};

			const targetTimestamps = {
				db1: new Date('2024-01-01T11:59:59Z').getTime(),
				db2: new Date('2024-01-01T11:59:59Z').getTime(),
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, true);
		});

		it('should return false when database has no received data', async () => {
			// Mock database with tables that have no last_updated_record
			databasesStub.db1 = {
				table1: { last_updated_record: 0 },
				table2: { last_updated_record: 0 }
			};

			const targetTimestamps = {
				db1: new Date('2024-01-01T12:00:00Z').getTime(),
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, false);
			assert(loggerStub.debug.calledWithMatch('Database db1: No data received yet'));
		});

		it('should return false when database is not yet synchronized', async () => {
			// Mock database with tables that have older timestamps than target
			databasesStub.db1 = {
				table1: { last_updated_record: new Date('2024-01-01T11:00:00Z').getTime() }
			};

			const targetTimestamps = {
				db1: new Date('2024-01-01T12:00:00Z').getTime(),
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, false);
			assert(loggerStub.debug.calledWithMatch('Database db1: Not yet synchronized'));
		});

		it('should return false when database not found locally', async () => {
			// Only db1 exists locally
			databasesStub.db1 = {
				table1: { last_updated_record: new Date('2024-01-01T12:00:00Z').getTime() }
			};

			const targetTimestamps = {
				db1: new Date('2024-01-01T11:00:00Z').getTime(),
				db2: new Date('2024-01-01T11:00:00Z').getTime() // db2 doesn't exist locally
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, false);
			assert(loggerStub.debug.calledWithMatch('Database db2: Not found locally yet'));
		});

		it('should handle sub-millisecond precision correctly', async () => {
			// Target has sub-millisecond precision, received version matches exactly
			const targetTime = 1757517636009.8606; // High precision target (safe float64)
			const receivedVersion = 1757517636009.8606; // Exact match with sub-millisecond precision

			databasesStub.database1 = {
				table1: { last_updated_record: receivedVersion }
			};

			const targetTimestamps = { database1: targetTime };
			const result = await checkSyncStatus(targetTimestamps);

			// Should be synchronized because timestamps match exactly
			assert.strictEqual(result, true);
		});

		it('should find the most recent timestamp across multiple tables', async () => {
			// Multiple tables with different timestamps
			databasesStub.db1 = {
				table1: { last_updated_record: new Date('2024-01-01T11:00:00Z').getTime() },
				table2: { last_updated_record: new Date('2024-01-01T12:00:00Z').getTime() }, // Most recent
				table3: { last_updated_record: new Date('2024-01-01T10:00:00Z').getTime() }
			};

			const targetTimestamps = {
				db1: new Date('2024-01-01T11:30:00Z').getTime() // Less than most recent table
			};

			const result = await checkSyncStatus(targetTimestamps);
			assert.strictEqual(result, true); // Should use table2's timestamp (12:00)
		});
	});

	describe('checkSyncStatus with systemDatabaseOnly parameter', () => {
		let checkSyncStatus;
		let SYSTEM_SCHEMA_NAME;
		let databasesStub;

		beforeEach(() => {
			checkSyncStatus = cloneNode.__get__('checkSyncStatus');
			// Get the SYSTEM_SCHEMA_NAME constant from the module
			const hdbTerms = cloneNode.__get__('hdbTerms');
			SYSTEM_SCHEMA_NAME = hdbTerms.SYSTEM_SCHEMA_NAME;
			databasesStub = {};
			cloneNode.__set__('databases', databasesStub);
		});

		it('should check all databases when systemDatabaseOnly is false', async () => {
			databasesStub[SYSTEM_SCHEMA_NAME] = {
				table1: { last_updated_record: 1234567891000.0 }
			};
			databasesStub.userdb = {
				table1: { last_updated_record: 1234567891000.0 }
			};

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, false);

			// Should check both databases and return true (both synced)
			assert.strictEqual(result, true);
			assert(loggerStub.debug.calledWithMatch(`Database ${SYSTEM_SCHEMA_NAME}: Synchronized`));
			assert(loggerStub.debug.calledWithMatch('Database userdb: Synchronized'));
		});

		it('should only check system database when systemDatabaseOnly is true', async () => {
			databasesStub[SYSTEM_SCHEMA_NAME] = {
				table1: { last_updated_record: 1234567891000.0 }
			};
			databasesStub.userdb = {
				table1: { last_updated_record: 1234567889000.0 } // Behind, but should be skipped
			};

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, true);

			// Should only check system database and return true (system synced, userdb skipped)
			assert.strictEqual(result, true);
			assert(loggerStub.debug.calledWithMatch(`Database ${SYSTEM_SCHEMA_NAME}: Synchronized`));
			assert(loggerStub.debug.calledWithMatch('Database userdb: Skipping (waiting for system database only)'));
			assert(loggerStub.debug.neverCalledWith('Database userdb: Synchronized'));
		});

		it('should return false if system database is not synced when systemDatabaseOnly is true', async () => {
			databasesStub[SYSTEM_SCHEMA_NAME] = {
				table1: { last_updated_record: 1234567889000.0 } // Behind
			};
			databasesStub.userdb = {
				table1: { last_updated_record: 1234567891000.0 } // Synced but should be skipped
			};

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, true);

			// Should return false because system database is not synced
			assert.strictEqual(result, false);
			assert(loggerStub.debug.calledWithMatch(`Database ${SYSTEM_SCHEMA_NAME}: Not yet synchronized`));
		});

		it('should return false if user database is not synced when systemDatabaseOnly is false', async () => {
			databasesStub[SYSTEM_SCHEMA_NAME] = {
				table1: { last_updated_record: 1234567891000.0 } // Synced
			};
			databasesStub.userdb = {
				table1: { last_updated_record: 1234567889000.0 } // Behind
			};

			const targetTimestamps = {
				[SYSTEM_SCHEMA_NAME]: 1234567890000.0,
				userdb: 1234567890000.0
			};

			const result = await checkSyncStatus(targetTimestamps, false);

			// Should return false because userdb is not synced
			assert.strictEqual(result, false);
			assert(loggerStub.debug.calledWithMatch('Database userdb: Not yet synchronized'));
		});
	});
});
