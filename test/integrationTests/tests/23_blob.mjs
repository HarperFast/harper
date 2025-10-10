import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { req, reqRest } from '../utils/request.mjs';
import { restartServiceHttpWorkersWithTimeout } from '../utils/restart.mjs';
import { testData } from '../config/envConfig.mjs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { setTimeout } from 'node:timers/promises';
import { dropTable } from '../utils/table.mjs';
import { dropSchema } from '../utils/schema.mjs';
import { verifyFilesDoNotExist } from '../utils/file.mjs';
import { createBlobCustom } from '../utils/blob.mjs';
import { exec } from 'node:child_process';
import { timestamp } from '../utils/timestamp.mjs';


describe('23. Blob', () => {
	beforeEach(timestamp);

	const blobId = randomInt(1000000);
	let blobsPath;

	it('Add component for blobs', () => {
		return req()
			.send({ operation: 'add_component', project: 'blobs' })
			.expect((r) => assert.ok(r.body.message.includes('Successfully added project: blobs'), r.text))
			.expect(200);
	});

	it('Set Component File schema.graphql for blobs', () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'blobs',
				file: 'schema.graphql',
				payload:
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
					'}\n\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql'), r.text))
			.expect(200);
	});

	it('Set Component File resources.js for blobs', () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'blobs',
				file: 'resources.js',
				payload:
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
					'\t\t//blob and byte size 80 KB - 120 KB\n' +
					'\t\tlet blob = await createBlob(random.subarray(0,\n' +
					'\t\t\tMath.floor(Math.random() *  (120000 - 80000 + 1) + 80000)\n' +
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
					'blobcache.sourcedFrom(BlobCacheSource);\n' +
					'\n\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);
	});

	it('Change audit log auditRetention to 10s', () => {
		return req()
			.send({
				operation: 'set_configuration',
				logging_auditLog: true,
				logging_auditRetention: '10s',
			})
			.expect(200);
	});

	it('Restart Service: http workers and wait', () => {
		return restartServiceHttpWorkersWithTimeout(testData.restartHttpWorkersTimeout);
	});

	it('Confirm Blob schema and table created', () => {
		return req()
			.send({ operation: 'describe_all' })
			.expect((r) => {
				assert.ok(JSON.stringify(r.body).includes('"blob":{"BlobCache":{"schema":"blob","name":"BlobCache"'), r.text);
			})
			.expect(200);
	});

	it('Create blob', () => {
		return createBlobCustom(blobId, 80000, 120000);
	});

	it('Verify blob created in db', () => {
		return req()
			.send({
				operation: 'sql',
				sql: 'SELECT * FROM blob.BlobCache',
			})
			.expect((r) => {
				assert.ok(
					r.body.filter((item) => item.cacheKey === blobId.toString()),
					r.text
				);
				assert.equal(r.body[0].cacheKey, blobId.toString(), r.text);
				assert.ok(r.body[0].contentSize >= 80000 && r.body[0].contentSize <= 120000, r.text);
				assert.equal(r.body[0].encoding, 'gzip', r.text);
				assert.equal(r.body[0].httpStatus, 200, r.text);
				assert.equal(
					r.body[0].htmlContent.description,
					'Blobs that are not of type text/* can not be directly serialized as JSON, use as the body of a response or convert to another type',
					r.text
				);
				assert.ok(r.body[0].ttl, r.text);
				assert.ok(r.body[0].expiresAtTimestamp, r.text);
				assert.ok(!r.body[1], 'Only one record should have been created.\n' + r.text);
				console.log('Created blob with id: ' + blobId);
			})
			.expect(200);
	});

	it('Verify blob created on filesystem', async () => {
		const response = await req()
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.rootPath, r.text);
			})
			.expect(200);

		await setTimeout(5000);

		if (process.env.DOCKER_CONTAINER_ID) {
			await exec(
				`docker exec ${process.env.DOCKER_CONTAINER_ID} ls -al /home/harperdb/hdb/blobs/blob/0/0/ | tail -n 1`,
				(error, stdout, stderr) => {
					console.log('stdout: ' + stdout);
					const outputLineItems = stdout.split(' ');
					assert.ok(
						outputLineItems[4] >= 80000 && outputLineItems[4] <= 120000,
						'blob file size expected to be between 80KB and 120KB'
					);
				}
			);
			await setTimeout(9000);
		} else {
			blobsPath = path.resolve(path.join(response.body.rootPath, testData.blobsPath));
			assert.ok(await fs.pathExists(blobsPath), 'blobs path does not exist');
			const files = await fs.readdir(blobsPath);
			for (const file of files) {
				const filePath = blobsPath + '/' + file;
				const data = await fs.readFile(filePath);
				assert.ok(data.length >= 75000 && data.length <= 120000, 'read file content length not as expected');
				const stats = await fs.stat(filePath);
				assert.ok(stats.size >= 80000 && stats.size <= 120000, 'file stats size not as expected');
				console.log('Checked blob file: ' + filePath);
			}
		}
	});

	it('Read blob', () => {
		return reqRest(`/blobcache/${blobId}`)
			.set('Accept', '*/*')
			.expect((r) => {
				assert.ok(r.headers['content-length'] >= 80000 || r.headers['content-length'] <= 120000, r.text);
				console.log('Read blob with id: ' + blobId);
			})
			.expect(200);
	});

	it(`Delete blob ${blobId} from the db`, () => {
		return req()
			.send({
				operation: 'sql',
				sql: 'DELETE FROM blob.BlobCache',
			})
			.expect((r) => {
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
				assert.equal(r.body.deleted_hashes[0], `${blobId}`, r.text);
				console.log('Deleted blob from the db with id: ' + blobId);
			})
			.expect(200);
	});

	it('Verify blob deleted from the filesystem', async () => {
		await setTimeout(21000); //wait after auditRetention
		await verifyFilesDoNotExist(blobsPath);
	});

	it('Create another blob', async () => {
		await setTimeout(5000);
		const id = randomInt(1000000);
		await createBlobCustom(id, 80000, 120000);
	});

	it('Drop table BlobCache', () => {
		return dropTable('blob', 'BlobCache', true);
	});

	it('Verify blob deleted from the filesystem', async () => {
		await setTimeout(5000);
		await verifyFilesDoNotExist(blobsPath);
	});

	it('Restart Service: http workers and wait', () => {
		return restartServiceHttpWorkersWithTimeout(testData.restartHttpWorkersTimeout);
	});

	it('Create again another blob', async () => {
		await setTimeout(5000);
		const id = randomInt(1000000);
		await createBlobCustom(id, 80000, 120000);
		await setTimeout(5000);
	});

	it("Drop schema 'blob'", () => {
		return dropSchema('blob', true);
	});

	it('Verify blob deleted from the filesystem', async () => {
		await setTimeout(21000);
		await verifyFilesDoNotExist(blobsPath);
	});
});
