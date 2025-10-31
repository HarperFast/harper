import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'undici';
import { deployApplication, dropApplication } from '../../utils.mts';
import { join } from 'node:path';

describe('basic-without-package-json', () => {
	before(async () => {
		await dropApplication('basic-without-package-json');
		await deployApplication('basic-without-package-json', join(import.meta.dirname, 'fixture'));
	});

	after(async () => {
		await dropApplication('basic-without-package-json');
	});

	it('should return a basic index.html file', async () => {
		const response = await request('http://localhost:9926/index.html');
		assert.strictEqual(response.statusCode, 200);
		const body = await response.body.text();
		assert.ok(body.includes('<h1>basic-without-package-json</h1>'));
	});
});