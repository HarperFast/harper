import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';
import { envUrlRest } from '../config/envConfig.mjs';

const REDIRECT_CSV = [
	'utcStartTime,utcEndTime,path,host,version,redirectURL,operations,statusCode,regex',
	',,/api/old/route,,0,/api/new/route,,301,',
	',,/legacy/page,,0,/new/page,,302,',
].join('\n');

async function pollForReady(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${envUrlRest}/Rule/`);
			if (res.status === 200) return;
		} catch {
			// server still restarting
		}
		await sleep(500);
	}
	throw new Error('Timed out waiting for redirector component to be ready');
}

describe('25. Redirect Tests', () => {
	beforeEach(timestamp);

	it('Deploy redirector component from local fixture', async () => {
		await req()
			.send({
				operation: 'deploy_component',
				project: 'redirector',
				package: join(__dirname, '../../fixtures/template-redirector-3.0.1.tgz'),
				restart: true,
			})
			.expect((r) => assert.ok(r.body.message?.includes('Successfully deployed: redirector'), r.text))
			.expect(200);
		await pollForReady();
	});

	it('Seed redirect rules via CSV import', async () => {
		const res = await fetch(`${envUrlRest}/redirect`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/csv' },
			body: REDIRECT_CSV,
		});
		assert.ok(res.status < 300, `CSV seed failed with status ${res.status}`);
	});

	it('checkredirect returns matched rule for 301 path', async () => {
		const res = await fetch(`${envUrlRest}/checkredirect?path=/api/old/route`);
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.redirectURL, '/api/new/route');
		assert.strictEqual(body.statusCode, 301);
	});

	it('checkredirect returns matched rule for 302 path', async () => {
		const res = await fetch(`${envUrlRest}/checkredirect?path=/legacy/page`);
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.redirectURL, '/new/page');
		assert.strictEqual(body.statusCode, 302);
	});

	it('checkredirect returns 404 for non-existent path', async () => {
		const res = await fetch(`${envUrlRest}/checkredirect?path=/no-such-path-xyz`);
		assert.strictEqual(res.status, 404);
	});

	it('Rule table returns list of seeded rules', async () => {
		const res = await fetch(`${envUrlRest}/Rule/`);
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body), 'Expected array of rules');
		assert.ok(body.length >= 2, `Expected at least 2 rules, got ${body.length}`);
	});
});
