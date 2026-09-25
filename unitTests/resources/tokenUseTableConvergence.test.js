'use strict';

// system.hdb_oidc_token_use must end up in one shape on every node however its copy arrived, so a
// passive node (one that never runs an OIDC exchange) evicts the replay rows replicated to it. Each
// starting shape below is made by the exact call its producer makes, and the assertions read the
// durable __dbis__ descriptors, which are what a restart loads.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const { databases, table } = require('#src/resources/databases');
const bridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const CreateTableObject = require('#src/dataLayer/CreateTableObject').default;
const directive530 = require('#src/upgrade/directives/5-3-0').default;
const { getVersionsForUpgrade } = require('#src/upgrade/directives/directivesController');
const {
	declareTokenUseTable,
	ensureTokenUseTable,
	TOKEN_USE_TABLE,
} = require('#src/security/authn/oidc/tokenUseTable');
const manageThreads = require('#js/server/threads/manageThreads');

const ATTRIBUTE_NAMES = ['id', 'policy_id', 'used_at', 'expiresAt'];
const CANONICAL = {
	audit: true,
	schemaDefined: true,
	attributes: [
		{ name: 'expiresAt', type: undefined, expiresAt: true, indexed: true },
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

// The declared shape only; build bookkeeping (checkpoints, format, generation) legitimately differs by history.
function declaredShape(attributes, primary) {
	return {
		audit: primary.audit,
		schemaDefined: primary.schemaDefined,
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
	return declaredShape(Table.attributes, { audit: Table.audit, schemaDefined: Table.schemaDefined });
}

function assertCanonical() {
	assert.deepStrictEqual(durableShape(), CANONICAL);
	assert.deepStrictEqual(liveShape(), CANONICAL);
	const expiresAt = tokenUseTable().dbisDB.getSync(`${TOKEN_USE_TABLE}/expiresAt`);
	assert.strictEqual(expiresAt.indexingFailed, undefined);
	assert.strictEqual(expiresAt.indexingPID, undefined);
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

// The node that serves the exchanges: the pre-fix bootstrap plus the pre-fix exchange path's declaration.
async function createAsExchangingNode() {
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

function replayRow(id, expiresAt) {
	return { id, policy_id: 'deploy', used_at: Date.now(), expiresAt };
}

function indexedIds(expiresAtValue) {
	return Array.from(tokenUseTable().indices.expiresAt.getRange({ start: true }))
		.filter(({ key }) => key === expiresAtValue)
		.map(({ value }) => value);
}

describe('system.hdb_oidc_token_use converges on one declared shape', function () {
	this.timeout(60000);

	before(() => testUtils.ensureSystemTables());

	after(async () => {
		await dropTokenUseTable();
		await ensureTokenUseTable();
	});

	it('the node that upgrades first: the 5.3.0 directive creates the table in the canonical shape', async () => {
		await dropTokenUseTable();
		await runDirective530();
		assertCanonical();
	});

	it('the node that upgrades second, after a pre-fix peer created its copy: the directive completes it', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(['id']);
		await runDirective530();
		assertCanonical();
	});

	it('the node that upgrades second, after a fixed peer created its copy: the directive flags and backfills expiresAt, keeping unexpired fingerprints', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(ATTRIBUTE_NAMES);
		const spentAt = Date.now() - 60_000;
		const liveUntil = Date.now() + 3_600_000;
		await tokenUseTable().put(replayRow('spent', spentAt));
		await tokenUseTable().put(replayRow('in-window', liveUntil));

		await runDirective530();

		assertCanonical();
		assert.deepStrictEqual(indexedIds(spentAt), ['spent']);
		assert.deepStrictEqual(indexedIds(liveUntil), ['in-window']);
		assert.strictEqual((await tokenUseTable().get('in-window'))?.expiresAt, liveUntil);
	});

	it('both orders leave the passive node with every (name, type) the exchanging node replicates', async () => {
		await dropTokenUseTable();
		await createAsExchangingNode();
		const exchanging = tokenUseTable().attributes.map(({ name, type }) => ({ name, type }));

		for (const createPassive of [() => createAsPeerHandshake(['id']), () => createAsPreFixBootstrap()]) {
			await dropTokenUseTable();
			await createPassive();
			await ensureTokenUseTable();
			// harper-pro's ensureTableIfChanged logs "is defined locally, but attribute ..." for any of these it cannot find
			for (const { name, type } of exchanging)
				assert(
					tokenUseTable().attributes.some((attribute) => attribute.name === name && attribute.type === type),
					`passive node lacks ${name}`
				);
		}
	});

	it('an install already on a pre-fix 5.3.0 pre-release, which no directive reaches, is repaired by the boot declaration', async () => {
		for (const upgradeVersion of ['5.3.0', '5.3.0-beta.3', '5.3.1'])
			assert.deepStrictEqual(
				getVersionsForUpgrade({ data_version: '5.3.0-beta.2', upgrade_version: upgradeVersion }),
				[],
				`a directive would run for 5.3.0-beta.2 -> ${upgradeVersion}`
			);

		await dropTokenUseTable();
		await createAsPreFixBootstrap();
		const spentAt = Date.now() - 60_000;
		await tokenUseTable().put(replayRow('replicated', spentAt));

		await ensureTokenUseTable();

		assertCanonical();
		assert.deepStrictEqual(indexedIds(spentAt), ['replicated']);
	});

	it('leaves the exchanging node, already in the canonical shape, untouched', async () => {
		await dropTokenUseTable();
		await createAsExchangingNode();
		const before = descriptors();
		const buildBefore = tokenUseTable().indexingOperation;

		await runDirective530();
		await ensureTokenUseTable();

		assert.deepStrictEqual(descriptors(), before);
		assert.strictEqual(tokenUseTable().indexingOperation, buildBefore);
		assertCanonical();
	});

	it('flags an expiresAt that create_attribute left indexed but unflagged, without rebuilding its index', async () => {
		await dropTokenUseTable();
		await createAsPreFixBootstrap();
		// what `create_attribute` does for each of the missing names
		await tokenUseTable().addAttributes(ATTRIBUTE_NAMES.slice(1).map((name) => ({ name, indexed: true })));
		await tokenUseTable().indexingOperation;
		const spentAt = Date.now() - 60_000;
		await tokenUseTable().put(replayRow('spent', spentAt));
		assert.strictEqual(tokenUseTable().dbisDB.getSync(`${TOKEN_USE_TABLE}/expiresAt`).expiresAt, undefined);

		await ensureTokenUseTable();

		assertCanonical();
		assert.deepStrictEqual(indexedIds(spentAt), ['spent']);
	});

	it('audits a copy that replication created while logging.auditLog was off', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(['id'], { audit: false });
		assert.strictEqual(tokenUseTable().audit, false);

		await ensureTokenUseTable();

		assertCanonical();
	});

	it('makes a dynamic copy schema-defined', async () => {
		await dropTokenUseTable();
		createAsPeerHandshake(['id'], { schemaDefined: false });
		assert.strictEqual(tokenUseTable().schemaDefined, false);

		await ensureTokenUseTable();

		assertCanonical();
	});

	it('completes an expiresAt backfill that a previous start left failed', async () => {
		await dropTokenUseTable();
		await createAsPreFixBootstrap();
		const spentAt = Date.now() - 60_000;
		await tokenUseTable().put(replayRow('spent', spentAt));
		await ensureTokenUseTable();
		const key = `${TOKEN_USE_TABLE}/expiresAt`;
		tokenUseTable().dbisDB.putSync(key, { ...tokenUseTable().dbisDB.getSync(key), indexingFailed: true });

		await ensureTokenUseTable();

		assertCanonical();
		assert.deepStrictEqual(indexedIds(spentAt), ['spent']);
	});

	it('reports an expiresAt index that is still not complete after the declaration', async () => {
		await dropTokenUseTable();
		await ensureTokenUseTable();
		const key = `${TOKEN_USE_TABLE}/expiresAt`;
		// a build this process owns and has not finished, so the declaration leaves it alone
		tokenUseTable().dbisDB.putSync(key, {
			...tokenUseTable().dbisDB.getSync(key),
			indexingPID: process.pid,
			restartNumber: manageThreads.restartNumber,
			indexingIncarnation: manageThreads.processIncarnation,
		});

		await assert.rejects(
			ensureTokenUseTable(),
			/system\.hdb_oidc_token_use\.expiresAt is not yet a completed expiration index/
		);

		const descriptor = tokenUseTable().dbisDB.getSync(key);
		delete descriptor.indexingPID;
		delete descriptor.restartNumber;
		delete descriptor.indexingIncarnation;
		tokenUseTable().dbisDB.putSync(key, descriptor);
	});

	it('the exchange path declares the same table', () => {
		assert.strictEqual(declareTokenUseTable(), tokenUseTable());
		assertCanonical();
	});
});
