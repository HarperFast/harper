/**
 * redirector component integration test.
 *
 * Deploys redirector and verifies redirect rule loading,
 * lookups, host scoping, slash handling, query string operations, regex,
 * versioning, time-based rules, edge cases, and table CRUD.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '../utils/harperLifecycle.ts';

const REDIRECT_CSV = `utcStartTime,utcEndTime,path,host,version,redirectURL,operations,statusCode,regex
,,/shop/live-shopping,,0,/s/events,,301,
,,/p/shirts/,,0,/shop/mens-clothing/shirts?id=5678,,301,
,,/p/shirts/,www.example.com,0,/shop/mens-clothing/shirts?id=1234,,301,
,,/dir3/dir4,,0,/dir3/dir4/dir5,,301,0
,,/dir3/dir4/,,0,/dir3/dir4/dir6,,301,0
,,/dir2/file3,,0,/dir2/other3,qs:preserve=1,301,
,,/dir2/file4,,0,/dir2/other4,qs:filter=arg1,301,
,,/dir2/file5,,0,/dir2/other5,qs:filter=arg1&filter=arg2,301,
,,/dir1/*,,0,/dir2/,qs:preserve=1,301,1
,,/dir11/special-thing,,0,/dir99/,,301,0
,,/dir66/*,,0,/magic/shopping/deals,qs:filter=top&filter=fab,301,1
,,/p/shoes/,,0,/shop/shoes/v0?id=1236,,301,
,,/p/shoes/,,1,/shop/shoes/v1?id=1236,,301,
0,10,/p/shirts/help/,,0,/info/finding-the-perfect-shirt,,301,
,,/p/shirts/help/iron/,,0,/info/ironing-shirts,,301,`;

suite('Component: redirector', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);

		const deployBody = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: 'redirector',
			package: 'https://github.com/HarperFast/template-redirector',
			restart: true,
		});
		deepStrictEqual(deployBody, { message: 'Successfully deployed: redirector, restarting Harper' });

		// poll until ready
		const deadline = Date.now() + 30_000;
		while (true) {
			try {
				const check = await fetch(`${ctx.harper.httpURL}/Rule/`);
				if (check.status === 200) break;
			} catch {
				// server not yet accepting connections
			}
			if (Date.now() > deadline) throw new Error('Timed out waiting for redirector to be ready after deploy');
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		// seed redirect rules via CSV
		const csvRes = await fetch(`${ctx.harper.httpURL}/redirect`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/csv' },
			body: REDIRECT_CSV,
		});
		ok(csvRes.status < 300, `CSV seed failed with ${csvRes.status}: ${await csvRes.text()}`);

		// seed hosts table for host-scoped lookups
		await fetch(`${ctx.harper.httpURL}/Hosts/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ host: 'www.example.com', hostOnly: true }),
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('query param lookup returns correct redirect', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/shop/live-shopping`);
		strictEqual(res.status, 200);
		const body = await res.json();
		strictEqual(body.redirectURL, '/s/events');
		strictEqual(body.statusCode, 301);
	});

	test('Path header lookup returns same result', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect`, {
			headers: { Path: '/shop/live-shopping' },
		});
		const body = await res.json();
		strictEqual(body.redirectURL, '/s/events');
		strictEqual(body.statusCode, 301);
	});

	test('nonexistent path returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/does-not-exist/`);
		strictEqual(res.status, 404);
	});

	test('same path returns different redirect based on host', async () => {
		const withHost = await fetch(`${ctx.harper.httpURL}/checkredirect?h=www.example.com&path=/p/shirts/`);
		const withHostBody = await withHost.json();
		strictEqual(withHostBody.redirectURL, '/shop/mens-clothing/shirts?id=1234');

		const noHost = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/p/shirts/`);
		const noHostBody = await noHost.json();
		strictEqual(noHostBody.redirectURL, '/shop/mens-clothing/shirts?id=5678');
	});

	test('trailing slash distinguishes rules by default', async () => {
		const noSlash = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir3/dir4`);
		const noSlashBody = await noSlash.json();
		strictEqual(noSlashBody.redirectURL, '/dir3/dir4/dir5');

		const withSlash = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir3/dir4/`);
		const withSlashBody = await withSlash.json();
		strictEqual(withSlashBody.redirectURL, '/dir3/dir4/dir6');
	});

	test('si=1 makes slash insensitive', async () => {
		const noSlash = await fetch(`${ctx.harper.httpURL}/checkredirect?si=1&path=/dir2/file3`);
		const noSlashBody = await noSlash.json();
		strictEqual(noSlashBody.redirectURL, '/dir2/other3');

		const withSlash = await fetch(`${ctx.harper.httpURL}/checkredirect?si=1&path=/dir2/file3/`);
		const withSlashBody = await withSlash.json();
		strictEqual(withSlashBody.redirectURL, '/dir2/other3');
	});

	test('preserve=1 appends original query string via X-Query-String header', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir2/file3`, {
			headers: { 'X-Query-String': '?arg1=val1&arg2=val2' },
		});
		const body = await res.json();
		strictEqual(body.redirectURL, '/dir2/other3?arg1=val1&arg2=val2');
	});

	test('filter removes specified params via X-Query-String header', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir2/file4`, {
			headers: { 'X-Query-String': '?arg1=val1&arg2=val2' },
		});
		const body = await res.json();
		strictEqual(body.redirectURL, '/dir2/other4?arg2=val2');
	});

	test('filter with multiple params removes all specified via X-Query-String header', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir2/file5`, {
			headers: { 'X-Query-String': '?arg1=val1&arg2=val2&arg3=val3' },
		});
		const body = await res.json();
		strictEqual(body.redirectURL, '/dir2/other5?arg3=val3');
	});

	test('wildcard matches any sub-path', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir1/fileX`);
		const body = await res.json();
		strictEqual(body.redirectURL, '/dir2/');
	});

	test('similar prefix correctly disambiguated from regex', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir11/special-thing`);
		const body = await res.json();
		strictEqual(body.redirectURL, '/dir99/');
	});

	test('regex with query string filter via X-Query-String header', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/dir66/anything/file5`, {
			headers: { 'X-Query-String': '?top=1&foo=bar&fab=val5' },
		});
		const body = await res.json();
		strictEqual(body.redirectURL, '/magic/shopping/deals?foo=bar');
	});

	test('default version returns v0 redirect', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/p/shoes/`);
		const body = await res.json();
		strictEqual(body.redirectURL, '/shop/shoes/v0?id=1236');
	});

	test('explicit v=1 returns v1 redirect', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?v=1&path=/p/shoes/`);
		const body = await res.json();
		strictEqual(body.redirectURL, '/shop/shoes/v1?id=1236');
	});

	test('expired rule returns 404 at current time', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=/p/shirts/help/`);
		strictEqual(res.status, 404);
	});

	test('time override within window returns redirect', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?t=5&path=/p/shirts/help/`);
		const body = await res.json();
		strictEqual(body.redirectURL, '/info/finding-the-perfect-shirt');
	});

	test('empty path returns null', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect?path=`);
		const body = await res.json();
		strictEqual(body, null);
	});

	test('no path param returns null', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/checkredirect`);
		const body = await res.json();
		strictEqual(body, null);
	});

	test('CSV import with missing path loads 0 rules', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/redirect`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/csv' },
			body: 'redirectURL\n/somewhere',
		});
		const body = await res.text();
		ok(body.includes('0'), `expected 0 loaded, got: ${body}`);
	});

	test('CSV import with missing redirectURL loads 0 rules', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/redirect`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/csv' },
			body: 'path\n/from-here',
		});
		const body = await res.text();
		ok(body.includes('0'), `expected 0 loaded, got: ${body}`);
	});

	test('Version table CRUD', async () => {
		// create
		const createRes = await fetch(`${ctx.harper.httpURL}/Version/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ activeVersion: 1 }),
		});
		ok(createRes.status < 300, `create failed: ${createRes.status}`);
		const versionId = String(await createRes.json());
		ok(versionId, 'expected version ID');

		// update
		const updateRes = await fetch(`${ctx.harper.httpURL}/Version/${versionId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ activeVersion: 2 }),
		});
		ok(updateRes.status < 300, `update failed: ${updateRes.status}`);

		// delete
		const deleteRes = await fetch(`${ctx.harper.httpURL}/Version/${versionId}`, {
			method: 'DELETE',
		});
		const deleteBody = await deleteRes.json();
		strictEqual(deleteBody, true);
	});

	test('Hosts table CRUD', async () => {
		// create
		const createRes = await fetch(`${ctx.harper.httpURL}/Hosts/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ host: 'ci-test-host', hostOnly: true }),
		});
		ok(createRes.status < 300, `create failed: ${createRes.status}`);

		// update
		const updateRes = await fetch(`${ctx.harper.httpURL}/Hosts/ci-test-host`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ hostOnly: false }),
		});
		ok(updateRes.status < 300, `update failed: ${updateRes.status}`);

		// delete
		const deleteRes = await fetch(`${ctx.harper.httpURL}/Hosts/ci-test-host`, {
			method: 'DELETE',
		});
		const deleteBody = await deleteRes.json();
		strictEqual(deleteBody, true);
	});

	test('deleting a rule makes its path return 404', async () => {
		const listRes = await fetch(`${ctx.harper.httpURL}/Rule/`);
		const rules = await listRes.json();
		ok(Array.isArray(rules) && rules.length > 0, 'expected at least 1 rule');

		const target = rules[rules.length - 1];

		const deleteRes = await fetch(`${ctx.harper.httpURL}/Rule/${target.id}`, {
			method: 'DELETE',
		});
		const deleteBody = await deleteRes.json();
		strictEqual(deleteBody, true);

		const checkRes = await fetch(`${ctx.harper.httpURL}/checkredirect?path=${encodeURIComponent(target.path)}`);
		strictEqual(checkRes.status, 404);
	});
});
