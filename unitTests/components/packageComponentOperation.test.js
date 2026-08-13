'use strict';

// Covers the three response shapes of the `package_component` operation handler against a real
// temporary components root: the streamed archive (`stream: true`), the size probe
// (`estimate: true`), and the historical base64 envelope (neither). The transport half — Fastify
// piping a returned Readable that carries a `headers` Map — is already covered by
// unitTests/server/serverHelpers/serverHandlers.test.js, so this file stops at the handler's
// return value.

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const operations = require('#js/components/operations');
const gunzip = require('gunzip-maybe');
const tar = require('tar-fs');

const PROJECT = 'pkg-op-app';
const FILES = {
	'package.json': '{"name":"pkg-op-app","version":"1.0.0"}\n',
	'index.js': 'module.exports = () => 42;\n',
	'docs/README.md': '# pkg-op-app\n',
	'node_modules/dep/index.js': 'module.exports = "dep";\n',
};

async function extractToTree(stream) {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-op-out-'));
	await pipeline(stream, gunzip(), tar.extract(outDir));
	const out = {};
	const walk = async (rel) => {
		for (const entry of await fs.readdir(path.join(outDir, rel), { withFileTypes: true })) {
			const childRel = rel ? path.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) await walk(childRel);
			else out[childRel] = await fs.readFile(path.join(outDir, childRel), 'utf8');
		}
	};
	await walk('');
	await fs.remove(outDir);
	return out;
}

describe('package_component (handler)', () => {
	let ROOT;

	before(() => {
		env.initTestEnvironment();
		ROOT = path.join(os.tmpdir(), `harper-pkg-op-${process.pid}`);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, ROOT);
		for (const [rel, content] of Object.entries(FILES)) {
			fs.outputFileSync(path.join(ROOT, PROJECT, rel), content);
		}
	});

	after(() => {
		fs.removeSync(ROOT);
	});

	describe('default (base64) shape', () => {
		it('still returns { project, payload } when neither selector is set', async () => {
			const result = await operations.packageComponent({ project: PROJECT, skip_node_modules: true });
			assert.equal(result.project, PROJECT);
			assert.equal(typeof result.payload, 'string');
			assert.ok(result.payload.length > 0, 'payload must not be empty');
			// A gzip member starts with 1f 8b, which base64-encodes to a leading "H4sI".
			assert.ok(result.payload.startsWith('H4sI'), `expected a gzip payload, got ${result.payload.slice(0, 8)}`);
		});
	});

	describe('stream: true', () => {
		it('returns a Readable carrying download headers, marked preCompressed', async () => {
			const stream = await operations.packageComponent({ project: PROJECT, stream: true, skip_node_modules: true });
			assert.ok(stream instanceof Readable, 'must return a Readable, not an envelope');
			assert.equal(stream.headers.get('content-type'), 'application/gzip');
			assert.equal(stream.headers.get('content-disposition'), `attachment; filename="${PROJECT}.tar.gz"`);
			// Without this serverHandlers would gzip the already-gzipped tar a second time.
			assert.strictEqual(stream.preCompressed, true);
			stream.destroy();
		});

		it('streams bytes that extract back to the source tree', async () => {
			const stream = await operations.packageComponent({ project: PROJECT, stream: true, skip_node_modules: true });
			const extracted = await extractToTree(stream);
			assert.deepEqual(extracted, {
				'package.json': FILES['package.json'],
				'index.js': FILES['index.js'],
				[path.join('docs', 'README.md')]: FILES['docs/README.md'],
			});
		});

		it('honors skip_node_modules: false by including the node_modules tree', async () => {
			const stream = await operations.packageComponent({ project: PROJECT, stream: true, skip_node_modules: false });
			const extracted = await extractToTree(stream);
			assert.equal(extracted[path.join('node_modules', 'dep', 'index.js')], FILES['node_modules/dep/index.js']);
		});

		it('never materializes the archive as a string — no payload field to blow the V8 cap', async () => {
			const stream = await operations.packageComponent({ project: PROJECT, stream: true });
			assert.strictEqual(stream.payload, undefined);
			stream.destroy();
		});
	});

	describe('estimate: true', () => {
		it('returns the packable size and no payload', async () => {
			const result = await operations.packageComponent({ project: PROJECT, estimate: true, skip_node_modules: true });
			const expected = Object.entries(FILES)
				.filter(([rel]) => !rel.startsWith('node_modules/'))
				.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0);
			assert.equal(result.project, PROJECT);
			assert.equal(result.total_size, expected);
			assert.deepEqual(result.dangling_symlinks, []);
			assert.strictEqual(result.payload, undefined, 'estimate must not package anything');
		});

		it('counts the node_modules tree when skip_node_modules is not set', async () => {
			const withMods = await operations.packageComponent({ project: PROJECT, estimate: true });
			const withoutMods = await operations.packageComponent({
				project: PROJECT,
				estimate: true,
				skip_node_modules: true,
			});
			assert.equal(withMods.total_size - withoutMods.total_size, Buffer.byteLength(FILES['node_modules/dep/index.js']));
		});

		it('wins over stream when a caller sets both', async () => {
			const result = await operations.packageComponent({ project: PROJECT, estimate: true, stream: true });
			assert.ok(!(result instanceof Readable));
			assert.equal(typeof result.total_size, 'number');
		});
	});

	describe('validation and resolution', () => {
		it('rejects a non-boolean selector', async () => {
			await assert.rejects(() => operations.packageComponent({ project: PROJECT, stream: 'yes-please' }), /stream/);
		});

		it('reports a project that exists in neither location rather than streaming an empty archive', async () => {
			await assert.rejects(
				() => operations.packageComponent({ project: 'no-such-project', stream: true }),
				/Unable to locate project/
			);
		});

		// A broken installation is not a missing project. The node_modules fallback rethrows
		// anything that isn't ENOENT (here ENOTDIR, from a rootPath whose node_modules is a
		// file) so the operator sees the real cause; flattening it into "Unable to locate
		// project" would send them looking for the wrong problem. Rethrowing is also what
		// leaves pathToProject guaranteed past that block, which the stream shape needs —
		// its headers are committed before the packer walks.
		it('rethrows a non-ENOENT fallback failure with its original code', async () => {
			const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-op-root-'));
			fs.writeFileSync(path.join(rootPath, 'node_modules'), 'not a directory');
			const priorRootPath = env.get(CONFIG_PARAMS.ROOTPATH);
			env.setProperty(CONFIG_PARAMS.ROOTPATH, rootPath);
			try {
				await assert.rejects(
					() => operations.packageComponent({ project: 'no-such-project', stream: true }),
					(err) => {
						assert.strictEqual(err.code, 'ENOTDIR', 'the original error code must survive');
						assert.ok(
							!/Unable to locate project/.test(err.message),
							`a broken installation must not read as a missing project: ${err.message}`
						);
						return true;
					}
				);
			} finally {
				env.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootPath);
				fs.removeSync(rootPath);
			}
		});
	});
});
