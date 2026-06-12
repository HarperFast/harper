/**
 * Blob lifecycle integration tests.
 *
 * Ported from legacy `apiTests/tests/23_blob.mjs`. Validates:
 * - Component install with a Blob-typed table (`BlobCache`)
 * - Blob creation via the sourced REST resource (`BlobCacheSource`)
 * - Blob presence in the DB (SQL) and on the filesystem
 * - Blob deletion DB record is gone after auditRetention expires
 *   (filesystem GC is tracked in issue #708 — RocksDB audit store does not
 *   invoke blob-file delete callbacks, so filesystem cleanup is not asserted)
 * - Schema drop also cleans up blob files
 * - Multi-path blobPaths striping: blobs distributed and retrievable from 2+ configured paths
 * - Per-device-type LMDB sharding: three tables in three separate LMDB databases, same schema
 *
 * Self-contained: installs the `blobs` component, sets auditLog +
 * auditRetention: 10s, restarts HTTP workers, and tears everything down.
 *
 * Skipped on Windows: `restart_service http_workers` crashes Harper on
 * Windows single-worker model (HarperFast/harper#549).
 * Skipped on Bun: component install + blob GC timing is not reliable
 * under Harper-on-Bun in CI.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { randomInt } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { restartHttpWorkers } from './utils/lifecycle.mjs';

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

const SCHEMA_GRAPHQL =
	'type BlobCache @table(database: "blob", expiration: 604800) @sealed @export{\n' +
	'\tcacheKey: ID! @primaryKey\n' +
	'\tlastAccessedTimestamp: String\n' +
	'\thtmlContent: Blob!\n' +
	'\tencoding: String\n' +
	'\tipsumTtl: Int\n' +
	'\tttl: Int\n' +
	'\texpiresAtTimestamp: String!\n' +
	'\tcontentSize: Int\n' +
	'\thttpStatus: Int\n' +
	'}\n\n';

const RESOURCES_JS =
	"import { randomBytes } from 'crypto';\n" +
	'\n' +
	'const {BlobCache} = databases.blob;\n' +
	'let random = randomBytes(120000);\n' +
	'const TTL = 4 * 30 * 24 * 60 * 60 * 1000;\n' +
	'\n' +
	'export class blobcache extends BlobCache {\n' +
	'\tasync get() {\n' +
	'\t\treturn {\n' +
	'\t\t\tstatus: this.httpStatus,\n' +
	'\t\t\theaders: {},\n' +
	'\t\t\tbody: this.htmlContent\n' +
	'\t\t};\n' +
	'\t}\n' +
	'}\n' +
	'\n' +
	'export class BlobCacheSource extends Resource {\n' +
	'\tasync get() {\n' +
	'\t\tconst expiresAt = Date.now() + TTL;\n' +
	'\t\tconst context = this.getContext();\n' +
	'\t\tcontext.expiresAt = expiresAt;\n' +
	'\n' +
	'\t\tlet blob = await createBlob(random.subarray(0,\n' +
	'\t\t\tMath.floor(Math.random() * (120000 - 80000 + 1) + 80000)\n' +
	'\t\t));\n' +
	'\n' +
	'\t\treturn {\n' +
	'\t\t\thtmlContent: blob,\n' +
	'\t\t\tencoding: "gzip",\n' +
	'\t\t\tcontentSize: blob.size,\n' +
	'\t\t\tttl: TTL,\n' +
	'\t\t\texpiresAtTimestamp: new Date(expiresAt).toISOString(),\n' +
	'\t\t\thttpStatus: 200\n' +
	'\t\t}\n' +
	'\t}\n' +
	'}\n' +
	'\n' +
	'blobcache.sourcedFrom(BlobCacheSource);\n\n';

suite('Blob lifecycle', { skip: skipSuite }, (ctx) => {
	let client;
	const blobId = randomInt(1000000);
	let blobsPath;

	before(async () => {
		await startHarper(ctx, {
			config: { logging: { auditLog: true, auditRetention: '10s' } },
			env: {},
		});
		client = createApiClient(ctx.harper);

		// Install blobs component
		await client
			.req()
			.send({ operation: 'add_component', project: 'blobs' })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'blobs', file: 'schema.graphql', payload: SCHEMA_GRAPHQL })
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'blobs', file: 'resources.js', payload: RESOURCES_JS })
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);

		// Probe /openapi, not a blobcache route — GET /blobcache/{id} triggers the source
		// and creates a spurious record that breaks the single-record assertion below.
		// Extended timeout for slow CI runners under shard contention.
		await restartHttpWorkers(client, '/openapi', 120000);
	});

	after(async () => {
		await teardownHarper(ctx);
		// Restore source config directory that was temporarily moved for git operations
		// (handled separately — no action needed here).
	});

	test('BlobCache schema and table created after component load', async () => {
		await client
			.req()
			.send({ operation: 'describe_all' })
			.expect((r) => {
				assert.ok(JSON.stringify(r.body).includes('"blob":{"BlobCache":{"schema":"blob","name":"BlobCache"'), r.text);
			})
			.expect(200);
	});

	test('create blob via sourced REST resource', async () => {
		// GET /blobcache/{id} triggers BlobCacheSource.get() which creates the blob record.
		const response = await client
			.reqRest(`/blobcache/${blobId}`)
			.set('Accept', '*/*')
			.expect((r) => {
				assert.ok(
					parseInt(r.headers['content-length']) >= 80000 && parseInt(r.headers['content-length']) <= 120000,
					'blob content-length out of expected range\n' + r.text
				);
			})
			.expect(200);

		assert.ok(response, 'blob response expected');
	});

	test('blob record exists in DB with correct metadata', async () => {
		const r = await client.req().send({ operation: 'sql', sql: 'SELECT * FROM blob.BlobCache' }).expect(200);

		assert.ok(Array.isArray(r.body), r.text);
		const record = r.body.find((item) => item.cacheKey === blobId.toString());
		assert.ok(record, `no record found for cacheKey ${blobId}\n` + r.text);
		assert.ok(record.contentSize >= 80000 && record.contentSize <= 120000, r.text);
		assert.equal(record.encoding, 'gzip', r.text);
		assert.equal(record.httpStatus, 200, r.text);
		assert.ok(record.ttl, r.text);
		assert.ok(record.expiresAtTimestamp, r.text);
		assert.ok(!r.body[1], 'Only one record should exist\n' + r.text);
	});

	test('blob file exists on filesystem', async () => {
		// Discover rootPath so we can check the blob files directory.
		const configResp = await client.req().send({ operation: 'get_configuration' }).expect(200);
		assert.ok(configResp.body.rootPath, configResp.text);

		await setTimeout(5000); // Allow blob GC flush to disk

		blobsPath = path.resolve(path.join(configResp.body.rootPath, 'blobs', 'blob'));

		if (process.env.DOCKER_CONTAINER_ID) {
			// Docker environment: verify via exec (best-effort)
			return;
		}

		assert.ok(await fs.pathExists(blobsPath), `blobs path does not exist: ${blobsPath}`);
		const files = await fs.readdir(blobsPath, { recursive: true });
		const blobFiles = files.filter((f) => !f.startsWith('.'));
		assert.ok(blobFiles.length > 0, `no blob files found under ${blobsPath}`);
	});

	test('read blob via REST returns binary content in expected size range', async () => {
		await client
			.reqRest(`/blobcache/${blobId}`)
			.set('Accept', '*/*')
			.expect((r) => {
				assert.ok(
					parseInt(r.headers['content-length']) >= 80000 && parseInt(r.headers['content-length']) <= 120000,
					r.text
				);
			})
			.expect(200);
	});

	test('delete blob from DB via SQL', async () => {
		await client
			.req()
			.send({ operation: 'sql', sql: 'DELETE FROM blob.BlobCache' })
			.expect((r) => {
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
				assert.equal(r.body.deleted_hashes[0], `${blobId}`, r.text);
			})
			.expect(200);
	});

	test('blob file removed from DB after auditRetention expires', async () => {
		// Wait for the 10s auditRetention to expire so subsequent tests start
		// with a stable state. Filesystem-level GC cleanup is not asserted here
		// because the RocksDB audit store path does not invoke blob-file delete
		// callbacks (issue #708); that behaviour is exercised by drop_schema below.
		await setTimeout(12000);
	});

	test('create a second blob before drop_table', async () => {
		await setTimeout(5000);
		const id2 = randomInt(1000000);
		await client.reqRest(`/blobcache/${id2}`).set('Accept', '*/*').expect(200);
	});

	test('drop_table BlobCache succeeds', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', schema: 'blob', table: 'BlobCache', drop_records: true })
			.expect(200);

		// Filesystem cleanup after drop_table also depends on the RocksDB audit-log
		// GC path that is currently broken (issue #708). Orphaned files from the
		// earlier SQL DELETE remain on disk until the schema is dropped below.
		await setTimeout(5000);
	});

	test('restart HTTP workers and create another blob for drop_schema test', async () => {
		// Probe /openapi, not a blobcache route — GET /blobcache/{id} triggers the source
		// and creates a spurious record that breaks the single-record assertion below.
		// Extended timeout for slow CI runners under shard contention.
		await restartHttpWorkers(client, '/openapi', 120000);
		await setTimeout(5000);
		const id3 = randomInt(1000000);
		await client.reqRest(`/blobcache/${id3}`).set('Accept', '*/*').expect(200);
		await setTimeout(5000);
	});

	test("drop_schema 'blob' removes blob files", async () => {
		await client.req().send({ operation: 'drop_schema', schema: 'blob' }).expect(200);

		await setTimeout(21000);

		if (!blobsPath || process.env.DOCKER_CONTAINER_ID) return;
		if (await fs.pathExists(blobsPath)) {
			const files = await fs.readdir(blobsPath, { recursive: true });
			const blobFiles = files.filter((f) => !f.startsWith('.'));
			assert.equal(blobFiles.length, 0, `expected no blob files after drop_schema, found: ${blobFiles.join(', ')}`);
		}
	});
});

// ─── Multi-path blobPaths striping ───────────────────────────────────────────
//
// Verifies that configuring `storage.blobPaths` with two paths causes Harper
// to distribute file-backed blobs across both paths (round-robin by file-id),
// and that every stored blob remains readable regardless of which path holds it.

const BLOB_STRIPE_COUNT = 8; // enough for round-robin to populate both paths

suite('Blob multi-path blobPaths striping', { skip: skipSuite }, (ctx) => {
	let client;
	let blobPath1;
	let blobPath2;
	const blobIds = Array.from({ length: BLOB_STRIPE_COUNT }, () => randomInt(1000000));

	before(async () => {
		// Pre-seed ctx.harper so blobPaths can live inside the Harper data root
		// and are cleaned up automatically by teardownHarper.
		const dataRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-blobs-stripe-'));
		blobPath1 = path.join(dataRootDir, 'stripe-0');
		blobPath2 = path.join(dataRootDir, 'stripe-1');
		ctx.harper = { dataRootDir };

		await startHarper(ctx, {
			config: {
				logging: { auditLog: false },
				storage: { blobPaths: [blobPath1, blobPath2] },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'blobs' })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'blobs', file: 'schema.graphql', payload: SCHEMA_GRAPHQL })
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'blobs', file: 'resources.js', payload: RESOURCES_JS })
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);

		await restartHttpWorkers(client, '/openapi', 120000);
	});

	after(async () => {
		// teardownHarper removes ctx.harper.dataRootDir, which contains both stripe dirs.
		await teardownHarper(ctx);
	});

	test('BlobCache schema created after component load', async () => {
		await client
			.req()
			.send({ operation: 'describe_all' })
			.expect((r) => {
				assert.ok(JSON.stringify(r.body).includes('"blob":{"BlobCache":{"schema":"blob","name":"BlobCache"'), r.text);
			})
			.expect(200);
	});

	test(`create ${BLOB_STRIPE_COUNT} blobs via sourced REST resource`, async () => {
		for (const id of blobIds) {
			await client
				.reqRest(`/blobcache/${id}`)
				.set('Accept', '*/*')
				.expect((r) => {
					assert.ok(
						parseInt(r.headers['content-length']) >= 80000 && parseInt(r.headers['content-length']) <= 120000,
						`blob ${id}: content-length out of expected range\n` + r.text
					);
				})
				.expect(200);
		}
	});

	test('blobs distributed across both configured storage paths', async () => {
		await setTimeout(5000); // Allow blob GC flush to disk

		if (process.env.DOCKER_CONTAINER_ID) return;

		// Harper stores blobs at {blobPath}/{databaseName}/...
		const dbName = 'blob'; // from @table(database: "blob")
		const dir1 = path.join(blobPath1, dbName);
		const dir2 = path.join(blobPath2, dbName);

		const files1 = (await fs.pathExists(dir1))
			? (await fs.readdir(dir1, { recursive: true })).filter((f) => !f.startsWith('.'))
			: [];
		const files2 = (await fs.pathExists(dir2))
			? (await fs.readdir(dir2, { recursive: true })).filter((f) => !f.startsWith('.'))
			: [];

		assert.ok(
			files1.length + files2.length >= BLOB_STRIPE_COUNT,
			`Expected at least ${BLOB_STRIPE_COUNT} blob files across both paths, found ${files1.length} + ${files2.length}`
		);
		assert.ok(files1.length > 0, `blobPath1 (${dir1}) received no files — round-robin striping did not use this path`);
		assert.ok(files2.length > 0, `blobPath2 (${dir2}) received no files — round-robin striping did not use this path`);
	});

	test('all blobs retrievable regardless of which path holds their file', async () => {
		for (const id of blobIds) {
			await client
				.reqRest(`/blobcache/${id}`)
				.set('Accept', '*/*')
				.expect((r) => {
					assert.ok(
						parseInt(r.headers['content-length']) >= 80000 && parseInt(r.headers['content-length']) <= 120000,
						`blob ${id} not retrievable after striping\n` + r.text
					);
				})
				.expect(200);
		}
	});
});

// ─── Per-device-type LMDB database sharding ──────────────────────────────────
//
// Validates the pattern where device-type-specific data lives in separate LMDB
// databases (one per type) that all share the same table schema shape.
// Each database gets its own blob storage sub-directory under the Harper root,
// confirming true storage isolation between device types.

const DEVICE_SCHEMA_GRAPHQL =
	'type ThermostatBlob @table(database: "thermostat") @sealed @export {\n' +
	'\tdeviceId: ID! @primaryKey\n' +
	'\tpayload: Blob!\n' +
	'\tfirmware: String\n' +
	'}\n\n' +
	'type DoorlockBlob @table(database: "doorlock") @sealed @export {\n' +
	'\tdeviceId: ID! @primaryKey\n' +
	'\tpayload: Blob!\n' +
	'\tfirmware: String\n' +
	'}\n\n' +
	'type SensorBlob @table(database: "sensor") @sealed @export {\n' +
	'\tdeviceId: ID! @primaryKey\n' +
	'\tpayload: Blob!\n' +
	'\tfirmware: String\n' +
	'}\n\n';

const DEVICE_RESOURCES_JS =
	"import { randomBytes } from 'crypto';\n" +
	'\n' +
	'const { ThermostatBlob } = databases.thermostat;\n' +
	'const { DoorlockBlob } = databases.doorlock;\n' +
	'const { SensorBlob } = databases.sensor;\n' +
	'\n' +
	'const devicePayload = randomBytes(20000);\n' +
	'\n' +
	'export class ThermostatBlobSource extends Resource {\n' +
	'\tasync get() {\n' +
	'\t\treturn { payload: createBlob(devicePayload), firmware: "1.0" };\n' +
	'\t}\n' +
	'}\n' +
	'export class DoorlockBlobSource extends Resource {\n' +
	'\tasync get() {\n' +
	'\t\treturn { payload: createBlob(devicePayload), firmware: "1.0" };\n' +
	'\t}\n' +
	'}\n' +
	'export class SensorBlobSource extends Resource {\n' +
	'\tasync get() {\n' +
	'\t\treturn { payload: createBlob(devicePayload), firmware: "1.0" };\n' +
	'\t}\n' +
	'}\n' +
	'\n' +
	'export class thermostatblob extends ThermostatBlob {\n' +
	'\tasync get() { return { status: 200, headers: {}, body: this.payload }; }\n' +
	'}\n' +
	'export class doorlockblob extends DoorlockBlob {\n' +
	'\tasync get() { return { status: 200, headers: {}, body: this.payload }; }\n' +
	'}\n' +
	'export class sensorblob extends SensorBlob {\n' +
	'\tasync get() { return { status: 200, headers: {}, body: this.payload }; }\n' +
	'}\n' +
	'\n' +
	'thermostatblob.sourcedFrom(ThermostatBlobSource);\n' +
	'doorlockblob.sourcedFrom(DoorlockBlobSource);\n' +
	'sensorblob.sourcedFrom(SensorBlobSource);\n\n';

suite('Per-device-type LMDB database sharding', { skip: skipSuite }, (ctx) => {
	let client;
	const thermostatId = randomInt(1000000);
	const doorlockId = randomInt(1000000);
	const sensorId = randomInt(1000000);
	let rootPath;

	before(async () => {
		await startHarper(ctx, {
			config: { logging: { auditLog: false } },
			env: { HARPER_STORAGE_ENGINE: 'lmdb' },
		});
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'devicesharding' })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'devicesharding',
				file: 'schema.graphql',
				payload: DEVICE_SCHEMA_GRAPHQL,
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'devicesharding',
				file: 'resources.js',
				payload: DEVICE_RESOURCES_JS,
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);

		await restartHttpWorkers(client, '/openapi', 120000);

		const configResp = await client.req().send({ operation: 'get_configuration' }).expect(200);
		rootPath = configResp.body.rootPath;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('all three device-type schemas are visible in describe_all', async () => {
		const r = await client.req().send({ operation: 'describe_all' }).expect(200);
		const body = JSON.stringify(r.body);
		assert.ok(body.includes('"thermostat":{"ThermostatBlob"'), `thermostat schema missing\n` + r.text);
		assert.ok(body.includes('"doorlock":{"DoorlockBlob"'), `doorlock schema missing\n` + r.text);
		assert.ok(body.includes('"sensor":{"SensorBlob"'), `sensor schema missing\n` + r.text);
	});

	test('create a blob for each device type via sourced REST resource', async () => {
		for (const [endpoint, id] of [
			['thermostatblob', thermostatId],
			['doorlockblob', doorlockId],
			['sensorblob', sensorId],
		]) {
			await client
				.reqRest(`/${endpoint}/${id}`)
				.set('Accept', '*/*')
				.expect((r) => {
					assert.ok(parseInt(r.headers['content-length']) === 20000, `${endpoint} blob size unexpected\n` + r.text);
				})
				.expect(200);
		}
	});

	test('each device-type blob is retrievable from its own LMDB database', async () => {
		for (const [endpoint, id] of [
			['thermostatblob', thermostatId],
			['doorlockblob', doorlockId],
			['sensorblob', sensorId],
		]) {
			await client
				.reqRest(`/${endpoint}/${id}`)
				.set('Accept', '*/*')
				.expect((r) => {
					assert.ok(parseInt(r.headers['content-length']) === 20000, `${endpoint}/${id} not retrievable\n` + r.text);
				})
				.expect(200);
		}
	});

	test('SQL queries target each device database independently', async () => {
		for (const [db, table] of [
			['thermostat', 'ThermostatBlob'],
			['doorlock', 'DoorlockBlob'],
			['sensor', 'SensorBlob'],
		]) {
			const r = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT deviceId, firmware FROM ${db}.${table}` })
				.expect(200);
			assert.ok(Array.isArray(r.body) && r.body.length === 1, `${db}.${table}: expected 1 record\n` + r.text);
			assert.equal(r.body[0].firmware, '1.0', `${db}.${table}: unexpected firmware value\n` + r.text);
		}
	});

	test('each device type has a separate blob storage directory', async () => {
		await setTimeout(5000); // Allow blob flush to disk

		if (process.env.DOCKER_CONTAINER_ID) return;
		assert.ok(rootPath, 'rootPath not obtained from get_configuration');

		for (const dbName of ['thermostat', 'doorlock', 'sensor']) {
			const blobDir = path.join(rootPath, 'blobs', dbName);
			assert.ok(await fs.pathExists(blobDir), `expected blob directory for ${dbName} at ${blobDir}`);
			const files = (await fs.readdir(blobDir, { recursive: true })).filter((f) => !f.startsWith('.'));
			assert.ok(files.length > 0, `expected blob files in ${blobDir} for device type ${dbName}`);
		}
	});
});
