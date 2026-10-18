const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { table, flushDatabases, closeDatabase, resolveDatabaseStorageRoot } = require('#js/resources/databases');
const { ensureSystemTables } = require('../testUtils.js');

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
		.flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return snapshot(path);
			return [
				{ path, modified: statSync(path).mtimeMs, hash: createHash('sha256').update(readFileSync(path)).digest('hex') },
			];
		});
}

describe('cold public package import', () => {
	it('exposes persisted tables in read-only build children without starting servers or workers', async () => {
		await ensureSystemTables();
		const database = 'data';
		const Dog = table({
			database,
			table: 'Dog',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await Dog.put({ id: 'rex', name: 'Rex' });
		await flushDatabases();
		const storagePath = join(
			resolveDatabaseStorageRoot(database),
			database + (process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? '.mdb' : '')
		);
		await closeDatabase(database, { requireClosed: true });
		const before = snapshot(storagePath);
		assert.ok(before.length > 0);
		for (const mode of ['compiled', 'typestrip']) {
			const runtime = mode === 'typestrip' ? '' : 'dist/';
			const extension = mode === 'typestrip' ? 'ts' : 'js';
			const url = (path) => pathToFileURL(resolve(__dirname, '../..', runtime + path + '.' + extension)).href;
			const output = execFileSync(
				process.execPath,
				[...(mode === 'typestrip' ? ['--conditions=typestrip'] : []), '--input-type=module'],
				{
					input: `
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
					env: { ...process.env, HARPER_READONLY: '1' },
					encoding: 'utf8',
					timeout: 20000,
				}
			);
			assert.match(output, /^Read-only package import complete$/m, mode);
			assert.deepStrictEqual(snapshot(storagePath), before, `${mode} import must not change read-only storage`);
		}
	});
});
