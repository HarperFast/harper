import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

async function packageFixture(directory: string, plugin = false): Promise<string> {
	const source = join(directory, plugin ? 'plugin' : 'app');
	await mkdir(source, { recursive: true });
	await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'branch-package', version: '1.0.0' }));
	if (plugin) {
		await writeFile(join(source, 'config.yaml'), 'pluginModule: plugin.js\n');
		await writeFile(
			join(source, 'plugin.js'),
			`export function handleApplication(scope) {
	const Records = scope.ensureTable({ database: 'data', table: 'Branched', attributes: [{ name: 'id', isPrimaryKey: true }] });
	return Records.put({ id: 'root-callback' });
}
`
		);
	} else {
		const child = join(source, 'node_modules', 'branch-child');
		await mkdir(child, { recursive: true });
		await writeFile(join(child, 'package.json'), JSON.stringify({ name: 'branch-child', version: '1.0.0' }));
		for (const [dir, name] of [
			[source, 'PackageProbe'],
			[child, 'ChildProbe'],
		]) {
			await writeFile(
				join(dir, 'config.yaml'),
				'jsResource:\n  files: resources.js\nrest: true\n' +
					(dir === source ? 'branch-child:\n  package: bundled\n' : '')
			);
			await writeFile(
				join(dir, 'resources.js'),
				`import { databases, Resource } from 'harper';
const Records = databases.data.Branched;
const initialized = Records.put({ id: '${name}-init' });
export class ${name} extends Resource {
	async get() {
		await initialized;
		return (await Records.get(this.getId())) ?? null;
	}
	async put(record) {
		await initialized;
		await Records.put({ ...record, id: this.getId() });
		return { id: this.getId() };
	}
}
`
			);
		}
	}
	const path = join(directory, plugin ? 'plugin.tgz' : 'app.tgz');
	await writeFile(path, Buffer.from(await targz(source), 'base64'));
	return `file:${path}`;
}

for (const isolated of [false, true]) {
	const project = isolated ? 'pkg-isolated' : 'pkg-shared';
	const host = `${project}.example.test`;
	const config = { threads: { count: 1 }, ...(isolated ? { tls: { unixDomainSockets: true } } : {}) };
	// Forks require RocksDB; this restart/UDS fixture also excludes Windows and isolated Bun workers.
	const unsupported =
		process.platform === 'win32' ||
		(isolated && process.env.HARPER_RUNTIME === 'bun') ||
		process.env.HARPER_STORAGE_ENGINE === 'lmdb';

	suite(
		`branched package application (${isolated ? 'dedicated' : 'shared'} worker)`,
		{ skip: unsupported },
		(ctx: ContextWithHarper) => {
			let directory: string;
			let pkg: string;
			const branchRoot = () => join(ctx.harper.dataRootDir, 'database', '`branches`', project);
			const baseRows = (ids: string[]) =>
				sendOperation(ctx.harper, {
					operation: 'search_by_id',
					database: 'data',
					table: 'Branched',
					ids,
					get_attributes: ['*'],
				});
			const auth = () =>
				`Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

			async function operation(body: Record<string, unknown>) {
				const response = await fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'authorization': auth() },
					body: JSON.stringify(body),
				});
				return { status: response.status, body: await response.json() };
			}

			async function appRequest(path: string, method = 'GET', record?: object) {
				const body = record === undefined ? undefined : JSON.stringify(record);
				const headers = { host, authorization: auth(), ...(body ? { 'content-type': 'application/json' } : {}) };
				const url = new URL(path, ctx.harper.httpURL);
				let address: { hostname: string; port: string } | { socketPath: string } = {
					hostname: url.hostname,
					port: url.port,
				};
				if (isolated) {
					const socketDir = join(ctx.harper.dataRootDir, 'sockets');
					let mirror: string;
					await waitFor(
						async () => {
							mirror = (await readdir(socketDir)).find(
								(name) => name.startsWith('app-pkg%2Disolated-') && name.endsWith(':9927.sock')
							);
							return mirror;
						},
						{ timeout: 30000, interval: 100, message: 'dedicated application socket was not created' }
					);
					address = { socketPath: join(socketDir, mirror) };
				}
				return new Promise<{ status: number; body: string }>((resolve, reject) => {
					const req = request({ ...address, path, method, headers }, (res) => {
						let data = '';
						res.on('data', (chunk) => (data += chunk));
						res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
					});
					req.on('error', reject);
					req.setTimeout(30000, () => req.destroy(new Error('application request timed out')));
					req.end(body);
				});
			}

			async function read(path: string) {
				const response = await appRequest(path);
				assert.strictEqual(response.status, 200, response.body);
				return JSON.parse(response.body);
			}

			// v5.3 deploys from the operations API without a load check, so a refused load answers 200 and
			// surfaces only once the restarted worker loads the package.
			async function deployRefusedAfterRestart(
				deployment: Record<string, unknown>,
				refused: () => Promise<boolean>,
				message: string
			) {
				const deployed = await operation(deployment);
				assert.strictEqual(deployed.status, 200, JSON.stringify(deployed.body));
				await waitFor(
					async () => {
						try {
							return await refused();
						} catch {
							return false;
						}
					},
					{ timeout: 30000, interval: 250, message }
				);
			}

			before(async () => {
				directory = await mkdtemp(join(tmpdir(), 'branch-pkg-'));
				pkg = await packageFixture(directory);
				await startHarper(ctx, { config });
				await sendOperation(ctx.harper, { operation: 'create_database', database: 'data' });
				await sendOperation(ctx.harper, {
					operation: 'create_table',
					database: 'data',
					table: 'Branched',
					primary_key: 'id',
				});
				await sendOperation(ctx.harper, {
					operation: 'insert',
					database: 'data',
					table: 'Branched',
					records: [{ id: 'seed', note: 'base' }],
				});
			});

			after(async () => {
				await teardownHarper(ctx);
				if (directory) await rm(directory, { recursive: true, force: true });
			});

			test(
				'package deploy keeps module and HTTP writes in the fork, including nested components',
				{ timeout: 180000 },
				async () => {
					const declaration = isolated ? true : ['data'];
					const deployment = {
						operation: 'deploy_component',
						project,
						package: pkg,
						isolated,
						host,
						branchedDatabases: declaration,
						restart: true,
					};
					const deployed = await operation(deployment);
					assert.strictEqual(deployed.status, 200, JSON.stringify(deployed.body));
					const rootConfig = parse(await readFile(join(ctx.harper.dataRootDir, 'harper-config.yaml'), 'utf8'));
					assert.strictEqual(rootConfig[project].package, pkg);
					assert.deepStrictEqual(rootConfig[project].branchedDatabases, declaration);
					assert.strictEqual((await read('/PackageProbe/seed')).note, 'base');
					assert.strictEqual((await read('/ChildProbe/seed')).note, 'base');
					assert.strictEqual((await read('/PackageProbe/PackageProbe-init')).id, 'PackageProbe-init');
					assert.strictEqual((await read('/PackageProbe/ChildProbe-init')).id, 'ChildProbe-init');
					assert.deepStrictEqual(
						await baseRows(['PackageProbe-init', 'ChildProbe-init']),
						[],
						'module initialization must never write the base'
					);
					for (const resource of ['PackageProbe', 'ChildProbe']) {
						const written = await appRequest(`/${resource}/${resource}-write`, 'PUT', { note: resource });
						assert.ok(written.status >= 200 && written.status < 300, written.body);
						assert.strictEqual((await read(`/PackageProbe/${resource}-write`)).note, resource);
					}
					assert.deepStrictEqual(await baseRows(['PackageProbe-write', 'ChildProbe-write']), []);
					assert.deepStrictEqual(
						await readdir(branchRoot()),
						['data'],
						'nested components share the application fork; true excludes system'
					);
					assert.ok(!existsSync(join(ctx.harper.dataRootDir, 'database', '`branches`', 'branch-child')));

					await sendOperation(ctx.harper, {
						operation: 'insert',
						database: 'data',
						table: 'Branched',
						records: [{ id: 'after-fork' }],
					});
					assert.strictEqual((await appRequest('/PackageProbe/after-fork')).status, 404);
					await killHarper(ctx);
					await startHarper(ctx, { config });
					assert.strictEqual((await read('/PackageProbe/ChildProbe-write')).note, 'ChildProbe');
					assert.deepStrictEqual(await baseRows(['PackageProbe-write', 'ChildProbe-write']), []);
				}
			);

			test(
				'a missing database fails the package load before any application module runs',
				{ timeout: 180000 },
				async () => {
					await deployRefusedAfterRestart(
						{
							operation: 'deploy_component',
							project,
							package: pkg,
							isolated,
							host,
							branchedDatabases: ['missingbranchdatabase'],
							restart: true,
						},
						// The previous release served this route.
						async () => (await appRequest('/PackageProbe/seed')).status === 404,
						'the package still served after its branch was refused'
					);
					assert.ok(!existsSync(join(branchRoot(), 'missingbranchdatabase')));
					assert.deepStrictEqual(await baseRows(['PackageProbe-init', 'ChildProbe-init']), []);
				}
			);

			test(
				'a root plugin package cannot invoke its callbacks on the shared root scope',
				{ timeout: 180000 },
				async () => {
					await deployRefusedAfterRestart(
						{
							operation: 'deploy_component',
							project,
							package: await packageFixture(directory, true),
							isolated,
							host,
							branchedDatabases: ['data'],
							restart: true,
						},
						async () => {
							const { componentStatus = [] } = (await operation({ operation: 'get_status' })).body;
							return componentStatus.find((entry: { name: string }) => entry.name === project)?.status === 'error';
						},
						'the root plugin package did not report its refused load'
					);
					assert.deepStrictEqual(await baseRows(['root-callback']), []);
				}
			);

			test('drop_component with restart removes the package fork', { timeout: 180000 }, async () => {
				assert.ok(existsSync(branchRoot()));
				await sendOperation(ctx.harper, { operation: 'drop_component', project, restart: true });
				await waitFor(() => !existsSync(branchRoot()), {
					timeout: 30000,
					interval: 100,
					message: 'drop left the application fork behind',
				});
				assert.strictEqual((await baseRows(['seed']))[0].note, 'base');
			});
		}
	);
}
