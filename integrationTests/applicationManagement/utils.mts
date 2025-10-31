import { pack } from 'tar-fs';
import { createGzip } from 'node:zlib';
import { request } from 'undici';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

export async function packFixture(fixturePath: string): Promise<string> {
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

export async function dropApplication(applicationName: string) {
	const { statusCode, body } = await request('http://localhost:9925', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			operation: 'drop_component',
			project: applicationName
		})
	});
	assert.equal(statusCode, 200, `Failed to remove application: ${await body.text()}`);
}

export async function deployApplication(applicationName: string, applicationFixturePath: string, sleepMs = 2000) {
	const payload = await packFixture(applicationFixturePath);
	const { statusCode, body } = await request('http://localhost:9925', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			operation: 'deploy_component',
			project: applicationName,
			payload,
			restart: true
		})
	});
	assert.equal(statusCode, 200, `Failed to deploy application: ${await body.text()}`);
	await sleep(sleepMs);
}
