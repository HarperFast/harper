import { request } from 'undici';
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pack } from 'tar-fs';
import { createGzip } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';

async function packFixture(): Promise<string> {
	const fixturePath = join(import.meta.dirname, 'fixture');
	const chunks: Buffer[] = [];
	return new Promise((resolve, reject) => {
		pack(fixturePath)
			.pipe(createGzip())
			.on('data', (chunk: Buffer) => chunks.push(chunk))
			.on('end', () => {
				resolve(Buffer.concat(chunks).toString('base64'));
			})
			.on('error', reject);
	});
}

async function dropFixture() {
	const { statusCode, body } = await request('http://localhost:9925', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			operation: 'drop_component',
			project: 'static-plugin-defaults'
		})
	});
	assert.equal(statusCode, 200, `Failed to remove application: ${await body.text()}`);
}

void suite('Static Plugin - Defaults', async () => {
	before(async () => {
		await dropFixture();
		const payload = await packFixture();
		const { statusCode, body } = await request('http://localhost:9925', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'deploy_component',
				project: 'static-plugin-defaults',
				payload,
				restart: true
			})
		});
		assert.equal(statusCode, 200, `Failed to deploy application: ${await body.text()}`);
		await sleep(1000);
	});

	after(async () => {
		await dropFixture();
	});

	await test('can access Harper instance', async () => {
		const { statusCode, body } = await request('http://localhost:9925/health');
		assert.equal(statusCode, 200);
		const responseBody = await body.text();
		assert.equal(responseBody, 'HarperDB is running.');
	});
	
	void test('can access index path', async () => {
		const { statusCode, body, headers } = await request('http://localhost:9926/');
		assert.equal(statusCode, 200);
		assert.ok(headers['content-type'].includes('text/html'));
	});
});