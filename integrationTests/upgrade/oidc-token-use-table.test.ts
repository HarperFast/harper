/**
 * system.hdb_oidc_token_use on a node that never runs an OIDC exchange: its workers must load the table with
 * its expiration, including on data a pre-fix 5.3.0 pre-release wrote, which no directive reaches because its
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
const EXPIRATION_SECONDS = 86_400;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

interface TableState {
	audit: boolean;
	schemaDefined: boolean;
	expiration: number | null;
	durableExpiration: number | null;
	attributes: { name: string; indexed: boolean; expiresAt: boolean }[];
	durable: Record<string, { indexed: boolean; expiresAt: boolean }>;
	rows: { id: string; expiresAt: number }[];
}

const DECLARED_ATTRIBUTES = [
	{ name: 'policy_id', indexed: false, expiresAt: false },
	{ name: 'used_at', indexed: false, expiresAt: false },
];

function tokenUseSuite(ctx: ContextWithHarper) {
	let client: ReturnType<typeof createApiClient>;

	function request(method: string, body?: unknown, id = ''): Promise<Response> {
		return fetch(`${ctx.harper.httpURL}/TokenUseTable/${id}`, {
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

	async function isVisible(id: string): Promise<boolean> {
		const response = await request('GET', undefined, id);
		strictEqual(response.status, 200, `/TokenUseTable/${id} should return 200, got ${response.status}`);
		return ((await response.json()) as { visible: boolean }).visible;
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
		deepStrictEqual(
			state.durable,
			Object.fromEntries(DECLARED_ATTRIBUTES.map(({ name, indexed, expiresAt }) => [name, { indexed, expiresAt }])),
			'__dbis__ declares the same attributes'
		);
		strictEqual(state.durableExpiration, EXPIRATION_SECONDS, '__dbis__ stores the expiration');
		strictEqual(state.expiration, EXPIRATION_SECONDS, 'the worker loaded the expiration');
		strictEqual(state.audit, true);
		strictEqual(state.schemaDefined, true);
	}

	return { request, readState, isVisible, boot, assertDeclared };
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
		const { request, readState, isVisible, boot, assertDeclared } = tokenUseSuite(ctx);
		const spentAt = Date.now() - 3_600_000;
		const written = {
			'spent-1': spentAt,
			'spent-2': spentAt - 1000,
			'in-window': Date.now() + 3_600_000,
		};

		function assertRowsAsWritten(rows: TableState['rows']) {
			deepStrictEqual(
				Object.fromEntries(rows.map(({ id, expiresAt }) => [id, expiresAt])),
				written,
				'every replay row keeps the expiry it was written with'
			);
		}

		function assertUndeclared(state: TableState) {
			deepStrictEqual(
				state.attributes.map(({ name }) => name),
				['id']
			);
			strictEqual(state.expiration, null);
			strictEqual(state.durableExpiration, null);
		}

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

		test('the pre-release leaves the primary-key-only stub, with no expiration, holding replicated replay rows', async () => {
			const response = await request('POST', {
				rows: Object.entries(written).map(([id, expiresAt]) => ({ id, expiresAt })),
			});
			strictEqual(response.status, 200, `writing replay rows should return 200, got ${response.status}`);
			const state = await readState();
			assertUndeclared(state);
			assertRowsAsWritten(state.rows);
		});

		test("the next writable boot declares it with its expiration, keeping each row's expiry", async () => {
			await killHarper(ctx);
			await boot(() => startHarper(ctx, { config: BOOT_CONFIG, env: {} }));
			const state = await readState();
			assertDeclared(state);
			// The spent rows may already be gone if the daily cleanup scan came due; the replay check skips them regardless.
			const kept = Object.fromEntries(state.rows.map(({ id, expiresAt }) => [id, expiresAt]));
			strictEqual(kept['in-window'], written['in-window'], 'the in-window row is kept with its expiry');
			for (const [id, expiresAt] of Object.entries(kept))
				strictEqual(expiresAt, written[id as keyof typeof written], `${id} keeps the expiry it was written with`);
			strictEqual(await isVisible('in-window'), true, 'an in-window replay row still blocks its token');
			strictEqual(await isVisible('spent-1'), false, 'a replay row past its expiry reads as absent');
		});

		// After the upgrade: a read-only boot over data from an older version exits at the upgrade step.
		test('a read-only boot of this build starts with the repaired table as it is', async () => {
			await killHarper(ctx);
			await boot(() => startHarper(ctx, { config: BOOT_CONFIG, env: { HARPER_READONLY: '1' } }));
			const state = await readState();
			assertDeclared(state);
			strictEqual(
				state.rows.find(({ id }) => id === 'in-window')?.expiresAt,
				written['in-window'],
				'the in-window row is kept with its expiry'
			);
			strictEqual(await isVisible('in-window'), true, 'an in-window replay row still blocks its token');
		});
	}
);
