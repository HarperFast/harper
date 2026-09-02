require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	_setSessionTableForTest,
	deleteSession,
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
		const loadHasRead = new Promise((resolve) => (loadRead = resolve));
		const loadRelease = new Promise((resolve) => (releaseLoad = resolve));
		const gatedTable = {
			get: async (recordId) => {
				const record = await SessionTable.get(recordId);
				loadRead();
				await loadRelease;
				return record;
			},
			patch: (...args) => SessionTable.patch(...args),
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
});
