/**
 * system.hdb_oidc_token_use on a node that never runs an OIDC exchange: it must reach worker start with the
 * full shape, including on data a pre-fix 5.3.0 pre-release wrote, which no directive reaches because its
 * data version sorts above every 5.3.0 directive.
 *
 * The pre-release suite needs HARPER_LEGACY_530_PRERELEASE_PATH (dist/bin/harper.js of harper@5.3.0-beta.2)
 * and is skipped without it. CI sets it everywhere but the uWS HTTP job: that registry install has no
 * uWebSockets.js, so under HARPER_UWS_HTTP the legacy binary's workers cannot bind.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'oidc-token-use-table');
const LEGACY_PRERELEASE_BIN_PATH = process.env.HARPER_LEGACY_530_PRERELEASE_PATH;
// Re-passed verbatim on every startHarper call: omitting it on a restart wipes config.
const BOOT_CONFIG = { logging: { console: true, level: 'error' } };
// The expiry sweep runs every 60s from worker start; the rest is boot and eviction slack.
const EVICTION_DEADLINE_MS = 150_000;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

interface TableState {
	audit: boolean;
	schemaDefined: boolean;
	attributes: { name: string; indexed: boolean; expiresAt: boolean }[];
	durable: Record<string, { indexed: boolean; expiresAt: boolean }>;
	rows: { id: string; expiresAt: number }[];
}

const DECLARED_ATTRIBUTES = [
	{ name: 'expiresAt', indexed: true, expiresAt: true },
	{ name: 'policy_id', indexed: false, expiresAt: false },
	{ name: 'used_at', indexed: false, expiresAt: false },
];

function tokenUseSuite(ctx: ContextWithHarper) {
	let client: ReturnType<typeof createApiClient>;

	function request(method: string, body?: unknown): Promise<Response> {
		return fetch(`${ctx.harper.httpURL}/TokenUseTable/`, {
			method,
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	async function readState(): Promise<TableState> {
		const response = await request('GET');
		strictEqual(response.status, 200, `/TokenUseTable/ should return 200, got ${response.status}`);
		return (await response.json()) as TableState;
	}

	async function boot(start: () => Promise<unknown>): Promise<void> {
		await start();
		client = createApiClient(ctx.harper);
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				if ((await request('GET')).status === 200) return;
			} catch {
				/* not up yet */
			}
			await sleep(250);
		}
		throw new Error('/TokenUseTable/ never returned 200 within 60s of the boot');
	}

	function assertDeclared(state: TableState) {
		deepStrictEqual(
			state.attributes.filter(({ name }) => name !== 'id').sort((a, b) => a.name.localeCompare(b.name)),
			DECLARED_ATTRIBUTES
		);
		ok(
			state.attributes.some(({ name }) => name === 'id'),
			'the primary key is kept'
		);
		for (const { name, indexed, expiresAt } of DECLARED_ATTRIBUTES)
			deepStrictEqual(state.durable[name], { indexed, expiresAt }, `__dbis__ declares ${name}`);
		strictEqual(state.audit, true);
		strictEqual(state.schemaDefined, true);
	}

	return { request, readState, boot, assertDeclared };
}

suite('system.hdb_oidc_token_use on a fresh install', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const { readState, boot, assertDeclared } = tokenUseSuite(ctx);

	before(async () => {
		await boot(() => setupHarperWithFixture(ctx, FIXTURE_PATH, { config: BOOT_CONFIG, env: {} }));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('is declared in full before any exchange', async () => {
		assertDeclared(await readState());
	});
});

suite(
	'system.hdb_oidc_token_use left by a pre-fix 5.3.0 pre-release is repaired at boot',
	{ skip: skipSuite || !LEGACY_PRERELEASE_BIN_PATH || !existsSync(LEGACY_PRERELEASE_BIN_PATH) },
	(ctx: ContextWithHarper) => {
		const { request, readState, boot, assertDeclared } = tokenUseSuite(ctx);
		const spentAt = Date.now() - 3_600_000;
		const inWindowUntil = Date.now() + 86_400_000;

		before(async () => {
			await boot(() =>
				setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: BOOT_CONFIG,
					env: {},
					harperBinPath: LEGACY_PRERELEASE_BIN_PATH,
				})
			);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('the pre-release leaves the primary-key-only stub holding replicated replay rows', async () => {
			const written = await request('POST', {
				rows: [
					{ id: 'spent-1', expiresAt: spentAt },
					{ id: 'spent-2', expiresAt: spentAt - 1000 },
					{ id: 'in-window', expiresAt: inWindowUntil },
				],
			});
			strictEqual(written.status, 200, `writing replay rows should return 200, got ${written.status}`);
			const state = await readState();
			deepStrictEqual(
				state.attributes.map(({ name }) => name),
				['id']
			);
			strictEqual(state.rows.length, 3);
		});

		test('a read-only boot of this build leaves it as it is', async () => {
			await killHarper(ctx);
			await boot(() => startHarper(ctx, { config: BOOT_CONFIG, env: { HARPER_READONLY: '1' } }));
			const state = await readState();
			deepStrictEqual(
				state.attributes.map(({ name }) => name),
				['id']
			);
			strictEqual(state.rows.length, 3);
		});

		test('the next writable boot declares it in full and evicts only the expired rows', async () => {
			await killHarper(ctx);
			await boot(() => startHarper(ctx, { config: BOOT_CONFIG, env: {} }));
			assertDeclared(await readState());

			const deadline = Date.now() + EVICTION_DEADLINE_MS;
			let rows: TableState['rows'];
			do {
				rows = (await readState()).rows;
				if (rows.length === 1) break;
				await sleep(2000);
			} while (Date.now() < deadline);
			deepStrictEqual(rows, [{ id: 'in-window', expiresAt: inWindowUntil }]);
		});
	}
);
