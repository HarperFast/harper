const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { readdirSync, readFileSync, statSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const databaseModule = require.resolve('#js/resources/databases');
const pidRootHelper = require.resolve('../perPidRoot.js');

function snapshot(directory) {
	if (!statSync(directory).isDirectory())
		return [
			{
				path: directory,
				modified: statSync(directory).mtimeMs,
				hash: createHash('sha256').update(readFileSync(directory)).digest('hex'),
			},
		];
	return readdirSync(directory, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => snapshot(join(directory, entry.name)));
}

function runChild(code, env, mode = 'compiled') {
	return execFileSync(
		process.execPath,
		[...(mode === 'typestrip' ? ['--conditions=typestrip'] : []), '--input-type=module'],
		{
			input: code,
			env,
			encoding: 'utf8',
			timeout: 20000,
		}
	);
}

describe('cold public package import', () => {
	it('exposes persisted tables in read-only build children without starting servers or workers', () => {
		let output = '';
		try {
			output = runChild(
				`
				const { createRequire } = await import('node:module');
				const require = createRequire(${JSON.stringify(pathToFileURL(pidRootHelper).href)});
				process.env.ROOTPATH = require(${JSON.stringify(pidRootHelper)}).materializePerPidRoot();
				delete process.env.STORAGE_PATH;
				delete process.env.SCHEMAS_DATA_PATH;
				delete process.env.HARPER_READONLY;
				console.log('fixture-root ' + process.pid);
				const { table, flushDatabases, closeDatabase } = require(${JSON.stringify(databaseModule)});
				const Dog = table({ database: 'data', table: 'Dog', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }] });
				await Dog.put({ id: 'rex', name: 'Rex' });
				await flushDatabases();
				await closeDatabase('data', { requireClosed: true });
				console.log('Fixture write complete');
				process.exit(0);
			`,
				process.env
			);
			assert.match(output, /^Fixture write complete$/m);
			const pid = /^fixture-root (\d+)\r?$/m.exec(output)?.[1];
			assert.ok(pid);
			const rootPath = join(dirname(pidRootHelper), 'envDir', pid);
			const storagePath = join(
				rootPath,
				'database',
				process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'data.mdb' : 'data'
			);
			const before = snapshot(storagePath);
			const storageEntries = readdirSync(dirname(storagePath)).sort();
			assert.ok(before.length > 0);
			for (const mode of ['compiled', 'typestrip']) {
				const runtime = mode === 'typestrip' ? '' : 'dist/';
				const extension = mode === 'typestrip' ? 'ts' : 'js';
				const url = (path) => pathToFileURL(resolve(__dirname, '../..', runtime + path + '.' + extension)).href;
				const childEnv = { ...process.env, ROOTPATH: rootPath, HARPER_READONLY: '1' };
				delete childEnv.STORAGE_PATH;
				delete childEnv.SCHEMAS_DATA_PATH;
				const readOutput = runChild(
					`
					const assert = (await import('node:assert')).default;
					const core = await import(${JSON.stringify(url('index'))});
					const { SERVERS } = await import(${JSON.stringify(url('server/serverRegistry'))});
					assert.strictEqual(core.tables, globalThis.tables);
					assert.ok(core.tables.Dog, 'public import must discover persisted tables');
					assert.deepStrictEqual({ ...await core.tables.Dog.get('rex') }, { id: 'rex', name: 'Rex' });
					assert.strictEqual(core.threads.length, 0);
					assert.ok(Object.values(SERVERS).every(server => !server.listening && !server.port));
					console.log('Read-only package import complete');
					process.exit(0);
				`,
					childEnv,
					mode
				);
				assert.match(readOutput, /^Read-only package import complete$/m, mode);
				assert.deepStrictEqual(snapshot(storagePath), before, `${mode} import must not change read-only storage`);
				assert.deepStrictEqual(readdirSync(dirname(storagePath)).sort(), storageEntries);
			}
		} catch (error) {
			output ||= error.stdout?.toString() ?? '';
			throw error;
		} finally {
			const pid = /^fixture-root (\d+)\r?$/m.exec(output)?.[1];
			if (pid) rmSync(join(dirname(pidRootHelper), 'envDir', pid), { recursive: true, force: true });
		}
	});
});
