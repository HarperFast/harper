/**
 * get_studio_configuration: what Studio reads to show the pages components add and the tabs a cluster hides.
 *
 * Studio's own flow on a new cluster is deploy_component, then set_configuration of the root `studio` settings, then
 * get_studio_configuration — back to back, with no restart — so each step here reads straight after the write it
 * depends on. The operation is open to every authenticated role, which only an end-to-end call through the operations
 * API and a role's own credentials shows, and it reads disk, so a worker thread answers it the same as the main one.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/studio-pages');
const PASSWORD = 'Abc1234!';
const DEPLOYED = 'studio-deployed';

const FIXTURE_PAGES = [
	{
		component: 'studio-pages',
		id: 'redirects',
		name: 'Redirects',
		icon: 'signpost',
		placement: 'tab',
		description: 'HTTP redirects served before your app runs.',
		access: { role: 'super_user', endpoints: ['/Redirect/'] },
		content: { kind: 'sections', sections: [{ kind: 'table', columns: ['from', 'to'] }] },
	},
];

suite('Component: get_studio_configuration', (ctx: ContextWithHarper) => {
	let scratch: string;

	function authorization(username: string, password: string) {
		return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
	}

	async function call(body: any, username?: string, password = PASSWORD): Promise<{ status: number; body: any }> {
		const headers = {
			'Content-Type': 'application/json',
			'Authorization':
				username === undefined
					? authorization(ctx.harper.admin.username, ctx.harper.admin.password)
					: authorization(username, password),
		};
		const response = await fetch(ctx.harper.operationsAPIURL, { method: 'POST', headers, body: JSON.stringify(body) });
		return { status: response.status, body: await response.json() };
	}

	async function studioConfiguration(username?: string) {
		const { status, body } = await call({ operation: 'get_studio_configuration' }, username);
		strictEqual(status, 200, JSON.stringify(body));
		return body;
	}

	async function addUser(role: string, permission: any) {
		const added = await call({ operation: 'add_role', role, permission });
		strictEqual(added.status, 200, JSON.stringify(added.body));
		const user = await call({
			operation: 'add_user',
			role,
			username: `${role}_user`,
			password: PASSWORD,
			active: true,
		});
		strictEqual(user.status, 200, JSON.stringify(user.body));
		return `${role}_user`;
	}

	async function deployPages(pageName: string, restart: boolean) {
		const directory = join(scratch, `${DEPLOYED}-${pageName}`);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, 'config.yaml'),
			`studio:\n  pages:\n    - { id: caching, name: ${pageName}, icon: database-zap, placement: config }\n`
		);
		const payload = await targz(directory);
		const deployed = await call({ operation: 'deploy_component', project: DEPLOYED, payload, restart });
		strictEqual(deployed.status, 200, JSON.stringify(deployed.body));
	}

	before(async () => {
		scratch = await mkdtemp(join(tmpdir(), 'studio-configuration-'));
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(scratch, { recursive: true, force: true });
	});

	test('a component declaring Studio pages loads, and its valid pages are returned with only page fields', async () => {
		const components = await call({ operation: 'get_components' });
		strictEqual(components.status, 200, JSON.stringify(components.body));
		const fixture = components.body.entries.find((entry: any) => entry.name === 'studio-pages');
		ok(fixture, 'the fixture component is listed');
		ok(fixture.status?.status !== 'error', `the fixture loaded cleanly: ${JSON.stringify(fixture.status)}`);
		deepStrictEqual(await studioConfiguration(), { pages: FIXTURE_PAGES });
	});

	// The harness boots with authentication.authorizeLocal, so a request with no credentials at all is the local admin.
	test('is refused to a caller that fails authentication', async () => {
		const { status } = await call(
			{ operation: 'get_studio_configuration' },
			ctx.harper.admin.username,
			'not-the-password'
		);
		strictEqual(status, 401);
	});

	test('answers a role with no permissions, and an allowlisted read_only role, the same as super_user', async () => {
		const unprivileged = await addUser('studio_no_permissions', { super_user: false });
		const readOnly = await addUser('studio_read_only', { super_user: false, operations: ['read_only'] });
		deepStrictEqual(await studioConfiguration(unprivileged), { pages: FIXTURE_PAGES });
		deepStrictEqual(await studioConfiguration(readOnly), { pages: FIXTURE_PAGES });
	});

	test('is refused to a role whose operations allowlist omits it', async () => {
		const omitting = await addUser('studio_omitting', { super_user: false, operations: ['describe_all'] });
		const { status, body } = await call({ operation: 'get_studio_configuration' }, omitting);
		strictEqual(status, 403, JSON.stringify(body));
	});

	test('returns the root settings set_configuration just wrote, without requesting a restart', async () => {
		const statusBefore = await call({ operation: 'get_status' });
		strictEqual(statusBefore.body.restartRequired, false, JSON.stringify(statusBefore.body));

		const written = await call({
			operation: 'set_configuration',
			studio_navigation: {
				'applications': 'hidden',
				'apis': 'hidden',
				'operations': 'tucked',
				'studio-pages.redirects': 'tucked',
			},
			studio_landing: 'studio-pages.redirects',
		});
		strictEqual(written.status, 200, JSON.stringify(written.body));
		deepStrictEqual(await studioConfiguration('studio_no_permissions_user'), {
			navigation: {
				'applications': 'hidden',
				'apis': 'hidden',
				'operations': 'tucked',
				'studio-pages.redirects': 'tucked',
			},
			landing: 'studio-pages.redirects',
			pages: FIXTURE_PAGES,
		});

		const statusAfter = await call({ operation: 'get_status' });
		strictEqual(statusAfter.body.restartRequired, false, 'a Studio setting is UI-only and needs no restart');

		const refused = await call({ operation: 'set_configuration', studio_navigation: { logs: 'gone' } });
		strictEqual(refused.status, 400, JSON.stringify(refused.body));

		const cleared = await call({ operation: 'set_configuration', studio_navigation: {}, studio_landing: null });
		strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
		deepStrictEqual(await studioConfiguration(), { pages: FIXTURE_PAGES });
	});

	test('a worker thread answers it from the same disk', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/StudioFromWorker`, {
			headers: { Authorization: authorization('studio_no_permissions_user', PASSWORD) },
		});
		const body = await response.json();
		strictEqual(response.status, 200, JSON.stringify(body));
		strictEqual(body.isMainThread, false);
		deepStrictEqual(body.configuration, await studioConfiguration());
	});

	test("a deployed component's pages are returned as soon as deploy_component answers, and leave with it", async () => {
		await deployPages('Caching', false);
		const deployedPage = { component: DEPLOYED, id: 'caching', icon: 'database-zap', placement: 'config' };
		deepStrictEqual((await studioConfiguration('studio_no_permissions_user')).pages, [
			{ ...deployedPage, name: 'Caching' },
			...FIXTURE_PAGES,
		]);

		await deployPages('Caching rules', true);
		deepStrictEqual((await studioConfiguration()).pages, [
			{ ...deployedPage, name: 'Caching rules' },
			...FIXTURE_PAGES,
		]);

		const dropped = await call({ operation: 'drop_component', project: DEPLOYED });
		strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
		deepStrictEqual((await studioConfiguration()).pages, FIXTURE_PAGES);
	});
});
