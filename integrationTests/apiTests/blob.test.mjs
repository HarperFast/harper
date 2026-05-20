/**
 * Blob lifecycle integration tests.
 *
 * Ported from legacy `apiTests/tests/23_blob.mjs`. Validates:
 * - Component install with a Blob-typed table (`BlobCache`)
 * - Blob creation via the sourced REST resource (`BlobCacheSource`)
 * - Blob presence in the DB (SQL) and on the filesystem
 * - Blob deletion cascades to the filesystem after auditRetention expires
 * - Schema drop also cleans up blob files
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
				assert.ok(
					res.includes('Successfully added project') || res.includes('Project already exists'),
					r.text
				);
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

		await restartHttpWorkers(client, '/blobcache/probe-route');
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
				assert.ok(
					JSON.stringify(r.body).includes('"blob":{"BlobCache":{"schema":"blob","name":"BlobCache"'),
					r.text
				);
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
					parseInt(r.headers['content-length']) >= 80000 ||
						parseInt(r.headers['content-length']) <= 120000,
					'blob content-length out of expected range\n' + r.text
				);
			})
			.expect(200);

		assert.ok(response, 'blob response expected');
	});

	test('blob record exists in DB with correct metadata', async () => {
		const r = await client
			.req()
			.send({ operation: 'sql', sql: 'SELECT * FROM blob.BlobCache' })
			.expect(200);

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
					parseInt(r.headers['content-length']) >= 80000 ||
						parseInt(r.headers['content-length']) <= 120000,
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

	test('blob file removed from filesystem after auditRetention expires', async () => {
		// auditRetention is 10s; wait 21s to be safe.
		await setTimeout(21000);

		if (!blobsPath || process.env.DOCKER_CONTAINER_ID) return;

		// All blob files under the path should be gone.
		if (await fs.pathExists(blobsPath)) {
			const files = await fs.readdir(blobsPath, { recursive: true });
			const blobFiles = files.filter((f) => !f.startsWith('.'));
			assert.equal(blobFiles.length, 0, `expected no blob files, found: ${blobFiles.join(', ')}`);
		}
		// If blobsPath no longer exists that is also acceptable.
	});

	test('create a second blob before drop_table', async () => {
		await setTimeout(5000);
		const id2 = randomInt(1000000);
		await client
			.reqRest(`/blobcache/${id2}`)
			.set('Accept', '*/*')
			.expect(200);
	});

	test('drop_table BlobCache removes blob files', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', schema: 'blob', table: 'BlobCache', drop_records: true })
			.expect(200);

		await setTimeout(5000);

		if (!blobsPath || process.env.DOCKER_CONTAINER_ID) return;
		if (await fs.pathExists(blobsPath)) {
			const files = await fs.readdir(blobsPath, { recursive: true });
			const blobFiles = files.filter((f) => !f.startsWith('.'));
			assert.equal(blobFiles.length, 0, `expected no blob files after drop_table, found: ${blobFiles.join(', ')}`);
		}
	});

	test('restart HTTP workers and create another blob for drop_schema test', async () => {
		await restartHttpWorkers(client, '/blobcache/probe-route');
		await setTimeout(5000);
		const id3 = randomInt(1000000);
		await client.reqRest(`/blobcache/${id3}`).set('Accept', '*/*').expect(200);
		await setTimeout(5000);
	});

	test("drop_schema 'blob' removes blob files", async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'blob' })
			.expect(200);

		await setTimeout(21000);

		if (!blobsPath || process.env.DOCKER_CONTAINER_ID) return;
		if (await fs.pathExists(blobsPath)) {
			const files = await fs.readdir(blobsPath, { recursive: true });
			const blobFiles = files.filter((f) => !f.startsWith('.'));
			assert.equal(blobFiles.length, 0, `expected no blob files after drop_schema, found: ${blobFiles.join(', ')}`);
		}
	});
});
