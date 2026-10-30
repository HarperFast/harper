import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { waitForLogMatches } from './waitForLog.ts';

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
				`import { databases, Resource, server } from 'harper';
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
` +
					(dir === source
						? `export class WorkerDrop extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const { project, ...options } = await data;
		return server.operation({ operation: 'drop_component', project, ...options, replicated: false });
	}
}
`
						: '')
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
				'package deploy and its canary keep module and HTTP writes in the fork, including nested components',
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
					assert.strictEqual(deployed.body.certification, 'certified');
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
				'a missing database rejects the certified load before any application module runs',
				{ timeout: 180000 },
				async () => {
					const failed = await operation({
						operation: 'deploy_component',
						project,
						package: pkg,
						isolated,
						host,
						branchedDatabases: ['missingbranchdatabase'],
						restart: true,
					});
					assert.strictEqual(failed.status, 400, JSON.stringify(failed.body));
					assert.strictEqual(failed.body.certification?.status, 'rejected', JSON.stringify(failed.body));
					assert.match(JSON.stringify(failed.body.certification), /missingbranchdatabase.*does not exist/);
					assert.ok(!existsSync(join(branchRoot(), 'missingbranchdatabase')));
					assert.deepStrictEqual(await baseRows(['PackageProbe-init', 'ChildProbe-init']), []);
				}
			);

			test(
				'a root plugin package cannot invoke its callbacks on the shared root scope',
				{ timeout: 180000 },
				async () => {
					const failed = await operation({
						operation: 'deploy_component',
						project,
						package: await packageFixture(directory, true),
						isolated,
						host,
						branchedDatabases: ['data'],
						restart: true,
					});
					assert.strictEqual(failed.status, 400, JSON.stringify(failed.body));
					assert.strictEqual(failed.body.certification?.status, 'rejected', JSON.stringify(failed.body));
					assert.match(
						JSON.stringify(failed.body.certification),
						/root plugin callbacks receive the shared root scope/
					);
					assert.deepStrictEqual(await baseRows(['root-callback']), []);
				}
			);

			const httpThreadIds = async () =>
				(await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] })).threads
					.filter((thread: { name: string }) => thread.name === 'http')
					.map((thread: { threadId: number }) => thread.threadId)
					.sort();

			test('drop_component with keepBranches keeps the package fork and says so', { timeout: 180000 }, async () => {
				assert.ok(existsSync(branchRoot()));
				const refused = await operation({ operation: 'drop_component', project, restart: true, keepBranches: true });
				assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
				assert.match(JSON.stringify(refused.body), /cannot be combined with 'restart: true'/);
				const dropped = await operation({ operation: 'drop_component', project, keepBranches: true });
				assert.strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
				assert.strictEqual(dropped.body.componentRemoved, true);
				assert.strictEqual(dropped.body.workerStopped, isolated);
				assert.strictEqual(dropped.body.branchesRemoved, false);
				assert.match(dropped.body.message, /left in place \(keepBranches\)/);
				assert.ok(existsSync(branchRoot()), 'the fork is still there');
			});

			test(
				'dropping the application again discards the fork it kept once nothing holds it, and restarts nothing',
				{ timeout: 180000 },
				async () => {
					if (!isolated) {
						// the shared workers still have it loaded, so its fork stays until they restart
						const kept = await operation({ operation: 'drop_component', project, restart: true });
						assert.strictEqual(kept.status, 200, JSON.stringify(kept.body));
						assert.strictEqual(kept.body.branchesRemoved, false, JSON.stringify(kept.body));
						assert.match(kept.body.message, /workers may still have it loaded/);
						const loaded = await httpThreadIds();
						await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http' });
						await waitFor(async () => (await httpThreadIds()).every((id: number) => !loaded.includes(id)), {
							timeout: 60000,
							interval: 250,
							message: 'the shared workers were not restarted',
						});
					}
					// A replacement that has not reported what it loaded yet may still hold it (on Bun, one starts only after its
					// predecessor exits), so the fork goes once every one has, removed by a drop or by the retry an earlier drop
					// recorded (harper#3463); a drop of the absent app restarts nothing meanwhile.
					let before: number[] = [];
					let dropped: { status: number; body: any } = { status: 0, body: undefined };
					await waitFor(
						async () => {
							before = await httpThreadIds();
							dropped = await operation({ operation: 'drop_component', project, restart: true });
							return dropped.status !== 200 || dropped.body.branchesRemoved !== false || !existsSync(branchRoot());
						},
						{ timeout: 60000, interval: 500, message: 'the fork was never discarded' }
					);
					assert.strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
					assert.strictEqual(dropped.body.componentRemoved, false, 'it was not on this node any more');
					assert.notStrictEqual(dropped.body.branchesRemoved, null, JSON.stringify(dropped.body));
					assert.ok(!existsSync(branchRoot()), 'the fork is gone');
					assert.deepStrictEqual(await httpThreadIds(), before, 'no worker was restarted');
					assert.strictEqual((await baseRows(['seed']))[0].note, 'base');
				}
			);

			test(
				`drop_component removes the package fork by default${isolated ? ', without a restart' : ''}`,
				{ timeout: 180000 },
				async () => {
					const deployed = await operation({
						operation: 'deploy_component',
						project,
						package: pkg,
						isolated,
						host,
						branchedDatabases: isolated ? true : ['data'],
						restart: true,
					});
					assert.strictEqual(deployed.status, 200, JSON.stringify(deployed.body));
					await read('/PackageProbe/seed');
					assert.ok(existsSync(branchRoot()));
					const dropped = await operation({ operation: 'drop_component', project, restart: !isolated });
					assert.strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
					assert.strictEqual(dropped.body.componentRemoved, true);
					assert.strictEqual(dropped.body.workerStopped, isolated);
					assert.strictEqual(dropped.body.branchesRemoved, true, JSON.stringify(dropped.body));
					assert.ok(!existsSync(branchRoot()), 'drop left the application fork behind');
					assert.strictEqual((await baseRows(['seed']))[0].note, 'base');
				}
			);

			test(
				`a fork whose removal fails after the drop answered is removed by ${isolated ? 'a later drop of another component' : 'the next start'}`,
				// root ignores the permission that makes the removal fail
				{ timeout: 240000, skip: process.getuid?.() === 0 },
				async () => {
					const deployed = await operation({
						operation: 'deploy_component',
						project,
						package: pkg,
						isolated,
						host,
						branchedDatabases: ['data'],
						restart: true,
					});
					assert.strictEqual(deployed.status, 200, JSON.stringify(deployed.body));
					await read('/PackageProbe/seed');
					const hold = join(branchRoot(), 'data', 'hold');
					await mkdir(hold);
					await writeFile(join(hold, 'keep'), '');
					await chmod(hold, 0o555);
					// Asked from a worker the drop then stops (the app's own) or replaces (a shared one, as a replicated peer runs
					// it), so main answers before it removes the fork, and the removal fails after that answer.
					const answer = await appRequest('/WorkerDrop', 'POST', { project, restart: !isolated });
					const dropped = { status: answer.status, body: JSON.parse(answer.body) };
					assert.strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
					assert.strictEqual(dropped.body.componentRemoved, true, JSON.stringify(dropped.body));
					assert.strictEqual(dropped.body.branchesRemoved, null, 'answered before the fork was removed');
					await waitForLogMatches(
						join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log'),
						[new RegExp(`Branched database storage of ${project} could not be removed`)],
						120000
					);
					assert.ok(existsSync(branchRoot()), 'the fork is still on disk');
					const unblock = async () => {
						for (const dir of [hold, join(branchRoot(), 'data`removing`', 'hold')]) {
							if (existsSync(dir)) await chmod(dir, 0o755);
						}
					};
					if (isolated) {
						await unblock();
						const unrelated = await operation({ operation: 'drop_component', project: 'never-here' });
						assert.strictEqual(unrelated.status, 200, JSON.stringify(unrelated.body));
					} else {
						// stopped first, so only the start can be what removes it
						await killHarper(ctx);
						await unblock();
						await startHarper(ctx, { config });
					}
					await waitFor(() => !existsSync(branchRoot()), {
						timeout: 60000,
						interval: 250,
						message: 'the fork was left on disk',
					});
					assert.strictEqual((await baseRows(['seed']))[0].note, 'base');
				}
			);
		}
	);
}
