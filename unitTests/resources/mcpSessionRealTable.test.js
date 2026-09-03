require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { patchIfExists } = require('#src/resources/Table');
const { PATCH_IF_EXISTS } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	_setSessionTableForTest,
	deleteSession,
	ensureSessionTable,
	loadSession,
	saveSession,
	touchSession,
} = require('#src/components/mcp/session');

describe('mcp/session with a real table', () => {
	let SessionTables;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		SessionTables = [false, true].map((audit) =>
			table({
				table: `McpSessionDeleteRace${audit ? 'Audited' : 'Unaudited'}`,
				database: 'test',
				audit,
				replicate: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'protocolVersion' },
					{ name: 'createdAt' },
					{ name: 'lastActivity' },
				],
			})
		);
		await Promise.all(SessionTables.map((Table) => Table.indexingOperation));
	});

	afterEach(() => _setSessionTableForTest(undefined));

	it('declares the MCP session table as non-replicated', () => {
		const SessionTable = ensureSessionTable();
		assert.equal(SessionTable.replicate, false);
		assert.equal(SessionTable.source, undefined);
	});

	it('keeps a deleted session absent when a late save reaches storage', async () => {
		for (const [index, SessionTable] of SessionTables.entries()) {
			const id = `real-mcp-session-late-save-${index}`;
			await SessionTable.put(id, { id, protocolVersion: '2025-06-18', createdAt: 1, lastActivity: 1 });
			_setSessionTableForTest(SessionTable);

			await deleteSession(id);
			await saveSession(id, { lastActivity: 2 });

			assert.equal(await SessionTable.get(id), undefined);
		}
	});

	it('does not resurrect a session loaded before a concurrent delete', async () => {
		const SessionTable = SessionTables[0];
		const id = 'real-mcp-session-in-flight-delete';
		await SessionTable.put(id, { id, protocolVersion: '2025-06-18', createdAt: 1, lastActivity: 1 });
		let releaseLoad;
		let loadRead;
		let gateLoad = true;
		const loadHasRead = new Promise((resolve) => (loadRead = resolve));
		const loadRelease = new Promise((resolve) => (releaseLoad = resolve));
		const gatedTable = {
			get: async (recordId) => {
				const record = await SessionTable.get(recordId);
				if (!gateLoad) return record;
				gateLoad = false;
				loadRead();
				await loadRelease;
				return record;
			},
			replicate: false,
			databaseName: SessionTable.databaseName,
			tableName: SessionTable.tableName,
			[PATCH_IF_EXISTS]: (...args) => SessionTable[PATCH_IF_EXISTS](...args),
			delete: (...args) => SessionTable.delete(...args),
		};
		_setSessionTableForTest(gatedTable);

		const staleLoad = loadSession(id);
		await loadHasRead;
		await deleteSession(id);
		releaseLoad();
		const staleSession = await staleLoad;
		await touchSession(staleSession);

		assert.equal(await SessionTable.get(id), undefined);
	});

	it('retries deletion when a newer concurrent save wins the first commit', async () => {
		const SessionTable = SessionTables[0];
		const id = 'real-mcp-session-delete-retry';
		await SessionTable.put(id, { id, protocolVersion: '2025-06-18', createdAt: 1, lastActivity: 1 });
		let deleteCalls = 0;
		const gatedTable = {
			get: (...args) => SessionTable.get(...args),
			replicate: false,
			databaseName: SessionTable.databaseName,
			tableName: SessionTable.tableName,
			[PATCH_IF_EXISTS]: (...args) => SessionTable[PATCH_IF_EXISTS](...args),
			delete: async (recordId) => {
				deleteCalls++;
				if (deleteCalls > 1) return SessionTable.delete(recordId);
				const context = { timestamp: SessionTable.primaryStore.getEntry(recordId).version };
				return transaction(context, async () => {
					await SessionTable.get(recordId, context);
					await patchIfExists(SessionTable, recordId, { lastActivity: 2 });
					await SessionTable.delete(recordId, context);
				});
			},
		};
		_setSessionTableForTest(gatedTable);

		await deleteSession(id);

		assert.equal(deleteCalls, 2);
		assert.equal(await SessionTable.get(id), undefined);
	});
});
