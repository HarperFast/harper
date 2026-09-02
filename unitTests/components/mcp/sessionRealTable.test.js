require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { _setSessionTableForTest, deleteSession, saveSession } = require('#src/components/mcp/session');

describe('mcp/session with a real table', () => {
	let SessionTable;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		SessionTable = table({
			table: 'McpSessionDeleteRace',
			database: 'test',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'lastActivity' }],
		});
		await SessionTable.indexingOperation;
	});

	afterEach(() => _setSessionTableForTest(undefined));

	it('keeps a deleted session absent when a late save reaches storage', async () => {
		const id = 'real-mcp-session-delete-race';
		await SessionTable.put(id, { id, lastActivity: 1 });
		_setSessionTableForTest(SessionTable);

		await deleteSession(id);
		await saveSession(id, { lastActivity: 2 });

		assert.equal(await SessionTable.get(id), undefined);
	});
});
