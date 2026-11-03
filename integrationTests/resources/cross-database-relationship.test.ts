/**
 * A @relationship whose target table lives in another database: Emp (database `data`) -> Vault and
 * Badge (database `hr`), Vault -> Org (database `org`), plus the reverse Vault.emps. A related-table read
 * must use the target database's read transaction. Passing the source table's one to the target
 * store makes RocksDB throw "Transaction belongs to a different database"; LMDB reads through an
 * unrelated transaction instead. A join's related-index scan runs after the request commits (REST
 * serializes after commit), so the target database's read handle must also outlive that commit.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'cross-database-relationship');
const ENGINES = ['rocksdb', 'lmdb'] as const;
const skipSuite = process.platform === 'win32';

for (const engine of ENGINES) {
	suite(`cross-database @relationship reads [${engine}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;

		function get(path: string): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				headers: { Authorization: client.headers.Authorization },
				signal: AbortSignal.timeout(30_000),
			});
		}

		async function getJSON(path: string): Promise<any> {
			const res = await get(path);
			const text = await res.text();
			strictEqual(res.status, 200, `GET ${path} failed: ${text}`);
			return JSON.parse(text);
		}

		async function gql(query: string): Promise<any> {
			const res = await client.reqGraphQl().send({ query }).timeout(30_000);
			strictEqual(res.status, 200, res.text);
			strictEqual(res.body.errors, undefined, JSON.stringify(res.body.errors));
			return res.body.data;
		}

		async function insert(database: string, table: string, records: any[]) {
			await client.req().send({ operation: 'insert', database, table, records }).expect(200);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: { HARPER_STORAGE_ENGINE: engine } });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			const deadline = Date.now() + 60_000;
			while ((await get('/StorageEngineInfo/').catch(() => null))?.status !== 200) {
				if (Date.now() > deadline) throw new Error('StorageEngineInfo route never became ready within 60s');
				await sleep(250);
			}
			await insert('org', 'Org', [
				{ id: 'o1', name: 'Acme' },
				{ id: 'o2', name: 'Globex' },
			]);
			await insert('hr', 'Vault', [
				{ id: 'v1', name: 'Alpha', orgId: 'o1' },
				{ id: 'v2', name: 'Beta', orgId: 'o2' },
			]);
			await insert('hr', 'Badge', [
				{ id: 'b1', label: 'gold' },
				{ id: 'b2', label: 'silver' },
			]);
			await insert('data', 'Emp', [
				{ id: 'e1', name: 'Ann', vaultId: 'v1', badgeIds: ['b1', 'b2'] },
				{ id: 'e2', name: 'Bob', vaultId: 'v1', badgeIds: ['b2'] },
				{ id: 'e3', name: 'Cid', vaultId: 'v2', badgeIds: [] },
			]);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('the requested storage engine is the one in effect', async () => {
			strictEqual((await getJSON('/StorageEngineInfo/')).engine, engine);
		});

		test('single record: many-to-one and many-to-many across databases', async () => {
			deepStrictEqual(await getJSON('/Emp/e1?select(id,vault{name},badges{label})'), {
				id: 'e1',
				vault: { name: 'Alpha' },
				badges: [{ label: 'gold' }, { label: 'silver' }],
			});
		});

		test('single record: one-to-many across databases', async () => {
			const vault = await getJSON('/Vault/v1?select(id,emps{id})');
			deepStrictEqual(vault.emps.map((emp: any) => emp.id).sort(), ['e1', 'e2']);
		});

		test('collection: many-to-one and many-to-many across databases', async () => {
			deepStrictEqual(await getJSON('/Emp/?select(id,vault{name},badges{label})&sort(+id)'), [
				{ id: 'e1', vault: { name: 'Alpha' }, badges: [{ label: 'gold' }, { label: 'silver' }] },
				{ id: 'e2', vault: { name: 'Alpha' }, badges: [{ label: 'silver' }] },
				{ id: 'e3', vault: { name: 'Beta' }, badges: [] },
			]);
		});

		test('collection: one-to-many across databases', async () => {
			const vaults = await getJSON('/Vault/?select(id,emps{id})&sort(+id)');
			deepStrictEqual(
				vaults.map((vault: any) => [vault.id, vault.emps.map((emp: any) => emp.id).sort()]),
				[
					['v1', ['e1', 'e2']],
					['v2', ['e3']],
				]
			);
		});

		test('filter on a related attribute across databases', async () => {
			const byVault = await getJSON('/Emp/?vault.name==Alpha&select(id,vault{name})&sort(+id)');
			deepStrictEqual(byVault, [
				{ id: 'e1', vault: { name: 'Alpha' } },
				{ id: 'e2', vault: { name: 'Alpha' } },
			]);
			const byBadge = await getJSON('/Emp/?badges.label==gold&select(id,badges{label})');
			deepStrictEqual(byBadge, [{ id: 'e1', badges: [{ label: 'gold' }] }]);
			const byEmp = await getJSON('/Vault/?emps.name==Cid&select(id,emps{id})');
			deepStrictEqual(byEmp, [{ id: 'v2', emps: [{ id: 'e3' }] }]);
		});

		test('filter through two relationship hops across three databases', async () => {
			deepStrictEqual(await getJSON('/Emp/?vault.org.name==Globex&select(id,vault{name,org{name}})'), [
				{ id: 'e3', vault: { name: 'Beta', org: { name: 'Globex' } } },
			]);
			deepStrictEqual(await getJSON('/Emp/?vault.org.name==Acme&select(id,name)&sort(+id)'), [
				{ id: 'e1', name: 'Ann' },
				{ id: 'e2', name: 'Bob' },
			]);
		});

		test('GraphQL: related rows across databases, both directions', async () => {
			const data = await gql('{ Emp(id: "e2") { id vault { name } badges { label } } }');
			deepStrictEqual(data.Emp, [{ id: 'e2', vault: { name: 'Alpha' }, badges: [{ label: 'silver' }] }]);
			const all = await gql('{ Emp { id vault { name } } }');
			deepStrictEqual(all.Emp.map((emp: any) => [emp.id, emp.vault.name]).sort(), [
				['e1', 'Alpha'],
				['e2', 'Alpha'],
				['e3', 'Beta'],
			]);
			const vaults = await gql('{ Vault { id emps { id } } }');
			deepStrictEqual(
				vaults.Vault.map((vault: any) => [vault.id, vault.emps.map((emp: any) => emp.id).sort()]).sort(),
				[
					['v1', ['e1', 'e2']],
					['v2', ['e3']],
				]
			);
		});
	});
}
