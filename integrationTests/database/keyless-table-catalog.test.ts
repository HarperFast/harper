/**
 * Tables with no primary key across restarts (harper#3225): a nameless bare `<table>/` catalog row without
 * isPrimaryKey must load with its records readable and writable, and a schema declaring a primary key on an
 * existing keyless table must load with the rest of its tables and leave that table keyless. Each half runs on
 * its own instance, so either one fails on its own signature.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	startHarper,
	setupHarperWithFixture,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { waitForLogMatches } from '../components/waitForLog.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'keyless-table-catalog');
// passed to every start so a restart never drops it
const BOOT_CONFIG = { threads: { count: 1 } };
const SCHEMA_WITH_DECLARED_KEYS = `type KeylessBareRow @table @export {
	name: String
}

type KeylessDeclared @table @export {
	id: ID @primaryKey
	name: String
}

type KeylessEmpty @table @export {
	id: ID @primaryKey
	name: String
}

type Keyed @table @export {
	id: ID @primaryKey
	name: String
}
`;

interface TableState {
	primaryKey: string | null;
	primaryAttributes: string[];
	attributes: string[];
	newIdType: string;
}

function instanceClient(ctx: ContextWithHarper) {
	let authorization: string;
	const refreshAuthorization = () => {
		authorization = createApiClient(ctx.harper).headers.Authorization;
	};
	const request = (path: string, init: RequestInit = {}): Promise<Response> =>
		fetch(new URL(path, ctx.harper.httpURL), {
			...init,
			headers: { 'Content-Type': 'application/json', 'Authorization': authorization, ...init.headers },
		});
	const getJson = async (path: string): Promise<any> => {
		const response = await request(path);
		const text = await response.text();
		strictEqual(response.status, 200, `GET ${path}: ${response.status} ${text}`);
		return JSON.parse(text);
	};
	const postRecord = async (table: string, record: object): Promise<string> => {
		const response = await request(`/${table}/`, { method: 'POST', body: JSON.stringify(record) });
		strictEqual(response.status, 201, `POST /${table}/: ${response.status} ${await response.text()}`);
		const location = response.headers.get('location');
		ok(location, `POST /${table}/ must return the new record's location`);
		return location!.split('/').pop()!;
	};
	const waitForRoute = async (path: string, maxWaitMs = 60_000): Promise<void> => {
		const deadline = Date.now() + maxWaitMs;
		let last = '';
		while (Date.now() < deadline) {
			try {
				const response = await request(path);
				last = `${response.status} ${await response.text()}`;
				if (response.status === 200) return;
			} catch (error) {
				last = String(error);
			}
			await sleep(250);
		}
		throw new Error(`${path} did not serve within ${maxWaitMs}ms; last response: ${last}`);
	};
	return {
		request,
		getJson,
		postRecord,
		waitForRoute,
		async start(): Promise<void> {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: BOOT_CONFIG, env: {} });
			refreshAuthorization();
			await waitForRoute('/KeylessBareRow/');
			const keyed = await request('/Keyed/k1', { method: 'PUT', body: JSON.stringify({ id: 'k1', name: 'keyed' }) });
			ok(keyed.status < 300, `PUT /Keyed/k1: ${keyed.status}`);
		},
		async restart(beforeStart?: () => Promise<void>): Promise<void> {
			await killHarper(ctx);
			await beforeStart?.();
			await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
			refreshAuthorization();
			await waitForRoute('/Keyed/k1');
		},
		async assertKeyless(table: string): Promise<void> {
			const state: TableState = await getJson(`/TableState/?table=${table}`);
			strictEqual(state.primaryKey, null, `${table} must stay keyless`);
			deepStrictEqual(state.primaryAttributes, [], `no live ${table} attribute may claim the primary key`);
			ok(state.attributes.includes('id'), `${table} must load the declared key as an ordinary attribute`);
			strictEqual(state.newIdType, 'number', `${table} must keep generating numeric ids`);
			const bareRow = await getJson(`/CatalogRow/?table=${table}`);
			strictEqual(bareRow?.name, undefined, `${table}'s bare row must not gain a key name`);
			const idDescriptor = await getJson(`/CatalogRow/?table=${table}&attribute=id`);
			ok(idDescriptor && !idDescriptor.isPrimaryKey, `${table}/id must persist as an ordinary attribute`);
		},
	};
}

suite(
	'a bare catalog row without isPrimaryKey across restarts (harper#3225)',
	{ timeout: 300_000 },
	(ctx: ContextWithHarper) => {
		const client = instanceClient(ctx);
		let bareRowId: string;

		before(async () => {
			await client.start();
			bareRowId = await client.postRecord('KeylessBareRow', { name: 'before the restart' });
			const strippedRow = await client.getJson('/StripPrimaryFlag/?table=KeylessBareRow');
			strictEqual(strippedRow.isPrimaryKey, undefined, 'the rewritten bare row must have committed without the flag');
			strictEqual(strippedRow.name, undefined);
			await client.restart();
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('starts and serves the table, and its new writes survive another restart', async () => {
			strictEqual((await client.getJson(`/KeylessBareRow/${bareRowId}`)).name, 'before the restart');
			const newId = await client.postRecord('KeylessBareRow', { name: 'after the restart' });
			strictEqual((await client.getJson(`/KeylessBareRow/${newId}`)).name, 'after the restart');
			strictEqual((await client.getJson('/Keyed/k1')).name, 'keyed');
			await client.restart();
			strictEqual((await client.getJson(`/KeylessBareRow/${bareRowId}`)).name, 'before the restart');
			strictEqual((await client.getJson(`/KeylessBareRow/${newId}`)).name, 'after the restart');
		});
	}
);

suite(
	'a schema declaring a primary key on a keyless table (harper#3225)',
	{ timeout: 300_000 },
	(ctx: ContextWithHarper) => {
		const client = instanceClient(ctx);
		let declaredId: string;

		before(async () => {
			await client.start();
			declaredId = await client.postRecord('KeylessDeclared', { name: 'before the declaration' });
			const componentDir = join(ctx.harper.dataRootDir, 'components', basename(FIXTURE_PATH));
			await client.restart(() => writeFile(join(componentDir, 'schema.graphql'), SCHEMA_WITH_DECLARED_KEYS, 'utf8'));
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('loads the schema and keeps a populated table keyless', async () => {
			strictEqual((await client.getJson(`/KeylessDeclared/${declaredId}`)).name, 'before the declaration');
			await client.assertKeyless('KeylessDeclared');
			const log = await waitForLogMatches(join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log'), [
				/Table 'data\.KeylessDeclared' has no primary key, so its declared primary key 'id' is ignored/,
			]);
			ok(!/Cannot change the primary key of table 'data\.KeylessDeclared'/.test(log));
		});

		test('keeps an empty table keyless across its first write and a restart', async () => {
			await client.assertKeyless('KeylessEmpty');
			const createdId = await client.postRecord('KeylessEmpty', { name: 'first write' });
			ok(/^\d+$/.test(createdId), `expected a numeric id, got ${createdId}`);
			await client.restart();
			strictEqual((await client.getJson(`/KeylessEmpty/${createdId}`)).name, 'first write');
			await client.assertKeyless('KeylessEmpty');
			await client.assertKeyless('KeylessDeclared');
		});
	}
);
