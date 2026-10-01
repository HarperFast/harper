'use strict';

// system.hdb_oidc_token_use must end up in one shape on every node however its copy arrived, so a
// passive node (one that never runs an OIDC exchange) removes the replay rows replicated to it. Each
// starting shape below is made by the exact call its producer makes, and the assertions read the
// durable __dbis__ descriptors, which are what a restart loads.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const { waitFor } = require('../waitFor.js');
const { databases, table, resetDatabases } = require('#src/resources/databases');
const bridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const CreateTableObject = require('#src/dataLayer/CreateTableObject').default;
const directive530 = require('#src/upgrade/directives/5-3-0').default;
const { getVersionsForUpgrade } = require('#src/upgrade/directives/directivesController');
const { declareTokenUseTable, TOKEN_USE_TABLE } = require('#src/security/authn/oidc/tokenUseTable');
const manageThreads = require('#js/server/threads/manageThreads');

// What a 5.3.0-beta.2 node that served exchanges declared, and so what its handshake sends a peer.
const BETA2_EXCHANGING_ATTRIBUTE_NAMES = ['id', 'policy_id', 'used_at', 'expiresAt'];
const CANONICAL = {
	audit: true,
	schemaDefined: true,
	expiration: 86_400,
	attributes: [
		{ name: 'id', type: undefined, isPrimaryKey: true },
		{ name: 'policy_id', type: undefined, expiresAt: false, indexed: false },
		{ name: 'used_at', type: undefined, expiresAt: false, indexed: false },
	],
};

function tokenUseTable() {
	return databases.system[TOKEN_USE_TABLE];
}

function descriptors() {
	const Table = tokenUseTable();
	const rows = [];
	for (const { value } of Table.dbisDB.getRange({ start: TOKEN_USE_TABLE + '/', end: TOKEN_USE_TABLE + '0' }))
		if (value && !value.dropping) rows.push(value);
	return rows;
}

// The declared shape only; bookkeeping (format, generation, table id) legitimately differs by history.
function declaredShape(attributes, primary) {
	return {
		audit: primary.audit,
		schemaDefined: primary.schemaDefined,
		expiration: primary.expiration,
		attributes: attributes
			.map((attribute) =>
				attribute.isPrimaryKey
					? { name: attribute.name, type: attribute.type, isPrimaryKey: true }
					: {
							name: attribute.name,
							type: attribute.type,
							expiresAt: Boolean(attribute.expiresAt),
							indexed: Boolean(attribute.indexed),
						}
			)
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function durableShape() {
	const rows = descriptors();
	return declaredShape(
		rows,
		rows.find((row) => row.isPrimaryKey)
	);
}

function liveShape() {
	const Table = tokenUseTable();
	return declaredShape(Table.attributes, {
		audit: Table.audit,
		schemaDefined: Table.schemaDefined,
		expiration: Table.expirationMS && Table.expirationMS / 1000,
	});
}

function assertCanonical() {
	assert.deepStrictEqual(durableShape(), CANONICAL);
	assert.deepStrictEqual(liveShape(), CANONICAL);
}

async function dropTokenUseTable() {
	await tokenUseTable()?.dropTable();
}

async function runDirective530() {
	for (const directive of directive530) for (const step of directive.async_functions) await step();
}

// The stub the pre-fix 5.3.0 directive and a fresh install (mount_hdb from systemSchema.json) create.
async function createAsPreFixBootstrap() {
	const createTable = new CreateTableObject('system', TOKEN_USE_TABLE, 'id');
	createTable.attributes = [{ attribute: 'id', isPrimaryKey: true }];
	createTable.audit = true;
	await bridge.createTable(TOKEN_USE_TABLE, createTable);
}

// A pre-5.3 node's replication handshake (harper-pro v5.2.13 ensureTableIfChanged -> ensureTable) creating
// a table it lacks from the peer's DB_SCHEMA, which carries only { name, type, isPrimaryKey } per attribute.
function createAsPeerHandshake(peerAttributeNames, options = {}) {
	table({
		table: TOKEN_USE_TABLE,
		database: 'system',
		schemaDefined: options.schemaDefined ?? true,
		...options,
		attributes: peerAttributeNames.map((name) => ({ name, type: undefined, isPrimaryKey: name === 'id' || undefined })),
	});
}

// A 5.3.0-beta.2 node that served exchanges: the bootstrap plus its exchange path's @expiresAt declaration.
async function createAsBeta2ExchangingNode() {
	await createAsPreFixBootstrap();
	table({
		table: TOKEN_USE_TABLE,
		database: 'system',
		audit: true,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'policy_id' },
			{ name: 'used_at' },
			{ name: 'expiresAt', expiresAt: true, indexed: true },
		],
	});
	await tokenUseTable().indexingOperation;
}

// A replay row as replication applies it: the sender's expiry arrives as the write's metadata. A beta.2
// sender's record also carries the field its @expiresAt declaration read.
function writeReplicatedRow(id, expiresAt, { withField = false } = {}) {
	const row = { id, policy_id: 'deploy', used_at: Date.now() };
	if (withField) row.expiresAt = expiresAt;
	return tokenUseTable().put(row, { expiresAt });
}

// A beta.2 exchange's own write, whose expiry came from the field alone.
function writeBeta2ExchangeRow(id, expiresAt) {
	return tokenUseTable().put({ id, policy_id: 'deploy', used_at: Date.now(), expiresAt });
}

function storedExpiresAt(id) {
	return tokenUseTable().primaryStore.getEntry(id)?.expiresAt;
}

// Not a get of the spent row: on RocksDB, evicting it on read leaves a tracked transaction behind that
// later suites' transaction monitors report.
async function assertExpiryKept(spentAt, liveUntil) {
	assert.strictEqual(storedExpiresAt('spent'), spentAt);
	assert.strictEqual(storedExpiresAt('in-window'), liveUntil);
	assert.strictEqual((await tokenUseTable().get('in-window'))?.policy_id, 'deploy');
}

// What a worker that never declares the table holds: a class built from the catalog alone.
function loadFromCatalog() {
	const Declared = tokenUseTable();
	Declared.cleanup();
	delete databases.system[TOKEN_USE_TABLE];
	resetDatabases();
	assert.ok(tokenUseTable() !== Declared, 'the table was rebuilt from the catalog');
	return tokenUseTable();
}

async function capturingCleanupScans(arm) {
	const originalSetTimeout = global.setTimeout;
	const scans = [];
	global.setTimeout = (callback, delay, ...args) => {
		if (new Error().stack.includes('scheduleCleanup')) scans.push(callback);
		return originalSetTimeout(callback, delay, ...args);
	};
	try {
		await arm();
	} finally {
		global.setTimeout = originalSetTimeout;
	}
	return scans;
}

describe('system.hdb_oidc_token_use converges on one declared shape', function () {
	this.timeout(60000);

	before(() => testUtils.ensureSystemTables());

	after(async () => {
		await dropTokenUseTable();
		declareTokenUseTable();
	});

	it('the node that upgrades first: the 5.3.0 directive creates the table in the canonical shape', async () => {
		await dropTokenUseTable();
		await runDirective530();
		assertCanonical();
	});

	const peerShapes = {
		'a beta.2 peer that never exchanged': ['id'],
		'a beta.2 peer that exchanged': BETA2_EXCHANGING_ATTRIBUTE_NAMES,
		'an upgraded peer': ['id', 'policy_id', 'used_at'],
	};
	for (const [peer, names] of Object.entries(peerShapes)) {
		it(`the node that upgrades second: the directive completes the copy its handshake took from ${peer}`, async () => {
			await dropTokenUseTable();
			createAsPeerHandshake(names);
			await runDirective530();
			assertCanonical();
		});
	}

	it('keeps the expiry of every row replicated to the copy it repairs', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(BETA2_EXCHANGING_ATTRIBUTE_NAMES);
		const spentAt = Date.now() - 60_000;
		const liveUntil = Date.now() + 3_600_000;
		await writeReplicatedRow('spent', spentAt, { withField: true });
		await writeReplicatedRow('in-window', liveUntil, { withField: true });

		await runDirective530();

		assertCanonical();
		await assertExpiryKept(spentAt, liveUntil);
	});

	it('no directive reaches an install already on a 5.3.0 pre-release', () => {
		for (const upgradeVersion of ['5.3.0', '5.3.0-beta.3', '5.3.1'])
			assert.deepStrictEqual(
				getVersionsForUpgrade({ data_version: '5.3.0-beta.2', upgrade_version: upgradeVersion }),
				[],
				`a directive would run for 5.3.0-beta.2 -> ${upgradeVersion}`
			);
	});

	const beta2Nodes = {
		'never exchanged': async (spentAt, liveUntil) => {
			await createAsPreFixBootstrap();
			await writeReplicatedRow('spent', spentAt, { withField: true });
			await writeReplicatedRow('in-window', liveUntil, { withField: true });
		},
		'exchanged': async (spentAt, liveUntil) => {
			await createAsBeta2ExchangingNode();
			await writeBeta2ExchangeRow('spent', spentAt);
			await writeBeta2ExchangeRow('in-window', liveUntil);
		},
	};
	for (const [node, create] of Object.entries(beta2Nodes)) {
		it(`the boot declaration repairs the table of a 5.3.0-beta.2 node that ${node}, keeping each row's expiry`, async () => {
			const spentAt = Date.now() - 60_000;
			const liveUntil = Date.now() + 3_600_000;
			await dropTokenUseTable();
			await create(spentAt, liveUntil);

			declareTokenUseTable();

			assertCanonical();
			// Only the declaring thread's class still holds a dropped index; the store stays on disk, unused.
			assert.ok(!('expiresAt' in loadFromCatalog().indices), 'a worker loading the table opens no expiresAt index');
			await assertExpiryKept(spentAt, liveUntil);
		});
	}

	it('leaves a table already in the canonical shape untouched', async () => {
		await dropTokenUseTable();
		declareTokenUseTable();
		const before = descriptors();
		const buildBefore = tokenUseTable().indexingOperation;

		await runDirective530();
		declareTokenUseTable();

		assert.deepStrictEqual(descriptors(), before);
		assert.strictEqual(tokenUseTable().indexingOperation, buildBefore);
		assertCanonical();
	});

	it('audits a copy that replication created while logging.auditLog was off', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(['id'], { audit: false });
		assert.strictEqual(tokenUseTable().audit, false);

		declareTokenUseTable();

		assertCanonical();
	});

	it('makes a dynamic copy schema-defined', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(['id'], { schemaDefined: false });
		assert.strictEqual(tokenUseTable().schemaDefined, false);

		declareTokenUseTable();

		assertCanonical();
	});

	it('a node that only loads the table from its catalog removes the rows past their expiry', async () => {
		await dropTokenUseTable();
		declareTokenUseTable();
		const spentAt = Date.now() - 60_000;
		const liveUntil = Date.now() + 3_600_000;
		await writeReplicatedRow('spent', spentAt);
		await writeReplicatedRow('in-window', liveUntil);

		// This thread stands in for the last worker, which owns the store's cleanup scan.
		const wasWorker = manageThreads.getWorkerIndex() === 0;
		manageThreads.setMainIsWorker(true);
		let scans;
		try {
			scans = await capturingCleanupScans(loadFromCatalog);
		} finally {
			manageThreads.setMainIsWorker(wasWorker);
		}
		assert.strictEqual(tokenUseTable().expirationMS, CANONICAL.expiration * 1000);
		assert.strictEqual(scans.length, 1, 'loading the table arms its cleanup scan');

		await scans[0]();

		await waitFor(() => tokenUseTable().primaryStore.getEntry('spent') === undefined, {
			timeout: 10000,
			message: 'the cleanup scan left the expired replay row in place',
		});
		assert.strictEqual(storedExpiresAt('in-window'), liveUntil);
	});

	it('under threads: 0, the first expiring write after the main thread becomes the worker arms the cleanup scan', async () => {
		await dropTokenUseTable();
		declareTokenUseTable();
		const spentAt = Date.now() - 60_000;
		const liveUntil = Date.now() + 3_600_000;
		await writeReplicatedRow('spent', spentAt);

		const wasWorker = manageThreads.getWorkerIndex() === 0;
		let scans;
		try {
			// startHTTPThreads makes the main thread the worker only after it has loaded and declared the table
			manageThreads.setMainIsWorker(false);
			const beforeOwnership = await capturingCleanupScans(() => {
				loadFromCatalog();
				declareTokenUseTable();
			});
			assert.strictEqual(beforeOwnership.length, 0);
			manageThreads.setMainIsWorker(true);
			scans = await capturingCleanupScans(() => writeReplicatedRow('in-window', liveUntil));
		} finally {
			manageThreads.setMainIsWorker(wasWorker);
		}
		assert.strictEqual(scans.length, 1, 'the write armed the cleanup scan');

		await scans[0]();

		await waitFor(() => tokenUseTable().primaryStore.getEntry('spent') === undefined, {
			timeout: 10000,
			message: 'the cleanup scan left the expired replay row in place',
		});
		assert.strictEqual(storedExpiresAt('in-window'), liveUntil);
	});

	it('the exchange path declares the same table', () => {
		assert.strictEqual(declareTokenUseTable(), tokenUseTable());
		assertCanonical();
	});
});
