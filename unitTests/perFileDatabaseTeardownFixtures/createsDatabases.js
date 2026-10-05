'use strict';

// First of the two files perFileDatabaseTeardown.test.js runs in one mocha process.

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, database, resetDatabases, table } = require('#src/resources/databases');

const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];

// declared while mocha loads the files, before any of them runs
table({ table: 'LoadedFirst', database: 'teardownProbeLoadTime', attributes });

let Own;

describe('a file that creates databases', () => {
	before(() => {
		setupTestDBPath();
	});

	it('writes to a database of its own and to a configured one', async () => {
		Own = table({ table: 'Own', database: 'teardownProbeOwn', attributes });
		await Own.put('own', { name: 'own' });
		await table({ table: 'TeardownProbeShared', database: 'test', attributes }).put('shared', { name: 'shared' });
	});

	it('closes a database it created, leaving it on disk', async () => {
		await table({ table: 'Closed', database: 'teardownProbeClosed', attributes }).put('closed', { name: 'closed' });
		await closeDatabase('teardownProbeClosed');
	});

	it('opens a database with no tables', () => {
		database({ database: 'teardownProbeTableless' });
	});

	it('configures a new database name that aliases the root of a configured one', () => {
		const configured = env.get(CONFIG_PARAMS.DATABASES);
		env.setProperty(CONFIG_PARAMS.DATABASES, { ...configured, teardownProbeAlias: configured.test });
		resetDatabases();
	});
});

describe('a later suite in the same file', () => {
	it('still has the database an earlier suite created', async () => {
		if ((await Own.get('own'))?.name !== 'own') throw new Error('the earlier suite’s database was dropped mid-file');
	});
});

// ends the file with a suite mocha runs no hooks for
describe('a suite whose tests are all conditional and absent', () => {});
