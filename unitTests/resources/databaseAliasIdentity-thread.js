'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { PassThrough, Readable } = require('node:stream');
const { closeLoadedDatabases, getDatabases, resetDatabases } = require('#src/resources/databases');
const {
	createBlob,
	decodeFromDatabase,
	getFilePathForBlob,
	saveBlob,
	setDeletionDelay,
} = require('#src/resources/blob');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { onMessageByType, setMainIsWorker } = require('#src/server/threads/manageThreads');

const MESSAGE_TYPE = 'database-alias-identity-test';
const CONTROL_TYPE = 'database-alias-identity-control';
const report = (event, details = {}) => parentPort.postMessage({ type: MESSAGE_TYPE, event, ...details });

function aliasState() {
	const databases = getDatabases();
	return Object.fromEntries(workerData.databaseAliasIdentityAliases.map((name) => [name, Boolean(databases[name])]));
}

// The table this thread loaded under the one alias given by `databaseAliasIdentityLoadOnly`.
function loadedTable() {
	const { database, table } = workerData.databaseAliasIdentityLoadOnly;
	return getDatabases()[database][table];
}

// held the way an in-flight request holds it, past any rescan of the catalog
let heldTable;

let streamSource;
let streamSaving;

const blobCommands = {
	async 'queue-deletion'({ deletionDelay }) {
		setDeletionDelay(deletionDelay);
		const Table = heldTable;
		const condemned = createBlob(Readable.from('condemned-generation'.repeat(64)));
		await Table.put({ id: 'superseded', blob: condemned });
		const condemnedPath = getFilePathForBlob(condemned);
		await Table.put({ id: 'superseded', blob: createBlob(Readable.from('next-generation'.repeat(64))) });
		report('deletion-queued', { condemnedPath });
	},
	'start-blob-stream'() {
		const { rootStore } = heldTable.primaryStore;
		streamSource = new PassThrough();
		streamSaving = decodeFromDatabase(() => saveBlob(createBlob(streamSource)).saving, rootStore);
		streamSaving.catch(() => {});
		streamSource.write(Buffer.alloc(20000, 's'));
		report('blob-stream-started');
	},
	async 'fail-blob-stream'() {
		streamSource.destroy(new Error('client went away'));
		const outcome = await streamSaving.then(
			() => 'saved',
			() => 'failed'
		);
		report('blob-stream-settled', { outcome });
	},
	async 'try-save'({ reloaded }) {
		let saving;
		try {
			const { rootStore } = (reloaded ? loadedTable() : heldTable).primaryStore;
			saving = decodeFromDatabase(() => saveBlob(createBlob(Buffer.alloc(20000, 't'))), rootStore).saving;
		} catch (error) {
			report('save-attempted', { admitted: false, statusCode: error.statusCode, message: error.message });
			return;
		}
		// settled before reporting: a save still writing when the thread closes its databases fails its unlock
		await saving?.catch(() => {});
		report('save-attempted', { admitted: true });
	},
};

function run() {
	require('#src/server/threads/itc');
	setMainIsWorker(true);
	onMessageByType(CONTROL_TYPE, () => {});
	const loadOnly = workerData.databaseAliasIdentityLoadOnly;
	if (loadOnly) {
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, loadOnly.storagePath);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, { [loadOnly.database]: { path: loadOnly.path } });
		resetDatabases();
	}
	const keepAlive = setInterval(() => {}, 1000);
	parentPort.on('message', async (message) => {
		if (message.type !== CONTROL_TYPE) return;
		if (message.command === 'inspect') report('inspected', { aliases: aliasState() });
		if (blobCommands[message.command]) {
			try {
				await blobCommands[message.command](message);
			} catch (error) {
				report('command-failed', { message: error.message });
			}
		}
		if (message.command === 'close') {
			await closeLoadedDatabases();
			clearInterval(keepAlive);
			report('closed');
			parentPort.close();
		}
	});
	const booted = { aliases: aliasState() };
	if (loadOnly) {
		heldTable = loadedTable();
		booted.blobIdentity = heldTable.primaryStore.rootStore.databaseName;
	}
	report('booted', booted);
}

if (parentPort) run();
