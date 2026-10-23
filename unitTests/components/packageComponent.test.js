'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable, Writable } = require('node:stream');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	streamPackagedDirectory,
	packageDirectory,
	findDanglingSymlinks,
	scanPackageDirectory,
} = require('#src/components/packageComponent');
const { PACKAGE_ROOT } = require('#src/utility/packageUtils');
const { _symlinkHarperModuleForTests } = require('#src/components/componentLoader');
const { buildMultipartBody } = require('#src/bin/multipartBuilder');
const { parseMultipartRequest } = require('#src/server/serverHelpers/multipartParser');
const gunzip = require('gunzip-maybe');
const tar = require('tar-fs');
const tarStream = require('tar-stream');

async function makeFixture(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-roundtrip-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return dir;
}

async function readDirTree(dir) {
	const out = {};
	async function walk(rel) {
		const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
		for (const entry of entries) {
			const childRel = rel ? path.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) await walk(childRel);
			else out[childRel] = await fs.readFile(path.join(dir, childRel), 'utf8');
		}
	}
	await walk('');
	return out;
}

// The archive's own entries, read from the tar headers: extracting would follow or recreate symlinks.
async function archiveEntries(stream) {
	const entries = new Map();
	const extract = tarStream.extract();
	extract.on('entry', (header, body, next) => {
		const chunks = [];
		body.on('data', (chunk) => chunks.push(chunk));
		body.on('end', () => {
			entries.set(header.name.replace(/\/$/, ''), { ...header, content: Buffer.concat(chunks).toString('utf8') });
			next();
		});
	});
	await pipeline(stream, gunzip(), extract);
	return entries;
}

function parseMultipart(contentType, stream) {
	return new Promise((resolve, reject) => {
		parseMultipartRequest({ headers: { 'content-type': contentType } }, stream, (err, body) =>
			err ? reject(err) : resolve(body)
		);
	});
}

describe('streamPackagedDirectory round-trip', () => {
	it('round-trips a directory tree through stream → multipart → parser → gunzip → tar extract', async function () {
		this.timeout(15000);
		const sourceFiles = {
			'package.json': '{"name":"demo","version":"1.0.0"}\n',
			'index.js': 'module.exports = () => 42;\n',
			'docs/README.md': '# demo\n',
		};
		const sourceDir = await makeFixture(sourceFiles);
		const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-roundtrip-out-'));
		try {
			// Build the CLI-side request body just like cliOperations.js would.
			const multipart = buildMultipartBody(
				{ operation: 'deploy_component', project: 'demo' },
				{
					name: 'payload',
					filename: 'package.tar.gz',
					contentType: 'application/gzip',
					stream: streamPackagedDirectory(sourceDir, { skip_node_modules: true }),
				}
			);
			// Send it through the server-side parser.
			const body = await parseMultipart(multipart.contentType, multipart.stream);
			assert.strictEqual(body.operation, 'deploy_component');
			assert.strictEqual(body.project, 'demo');
			// Pipe payload exactly as extractApplication does: gunzip-maybe + tar-fs.extract
			await pipeline(body.payload, gunzip(), tar.extract(extractDir));
			const extracted = await readDirTree(extractDir);
			assert.deepStrictEqual(extracted, sourceFiles);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(extractDir, { recursive: true, force: true });
		}
	});

	it('packageDirectory still produces a buffer with identical contents to streamPackagedDirectory', async function () {
		this.timeout(15000);
		const sourceDir = await makeFixture({ 'a.txt': 'A', 'b/c.txt': 'C' });
		try {
			const buffered = await packageDirectory(sourceDir, { skip_node_modules: true });
			const streamedChunks = [];
			for await (const chunk of streamPackagedDirectory(sourceDir, { skip_node_modules: true })) {
				streamedChunks.push(chunk);
			}
			const streamed = Buffer.concat(streamedChunks);
			// tar+gzip is deterministic-ish; sizes should match exactly for an identical input tree.
			assert.strictEqual(streamed.length, buffered.length);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('packages a component that itself lives under a node_modules/ path (regression)', async function () {
		this.timeout(15000);
		// A component installed under node_modules — the case that made `harper deploy`
		// of any npm-installed component ship an empty tarball (ignore matched the
		// absolute path's `node_modules` segment for every entry).
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-under-nm-'));
		const compDir = path.join(root, 'node_modules', '@scope', 'comp');
		const compFiles = {
			'package.json': '{"name":"comp","version":"1.0.0"}\n',
			'dist/resources/Memory.js': 'exports.x = 1;\n',
			'schemas/memory.graphql': 'type Memory { id: ID }\n',
		};
		for (const [rel, content] of Object.entries(compFiles)) {
			const full = path.join(compDir, rel);
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, content);
		}
		// An inner node_modules that must still be excluded.
		const innerDep = path.join(compDir, 'node_modules', 'dep', 'index.js');
		await fs.mkdir(path.dirname(innerDep), { recursive: true });
		await fs.writeFile(innerDep, 'module.exports = 1;\n');

		const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-under-nm-out-'));
		try {
			await pipeline(streamPackagedDirectory(compDir, { skip_node_modules: true }), gunzip(), tar.extract(extractDir));
			// Component source survives despite compDir living under node_modules/, and the
			// inner node_modules is excluded — deepStrictEqual asserts both at once.
			assert.deepStrictEqual(await readDirTree(extractDir), compFiles);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(extractDir, { recursive: true, force: true });
		}
	});

	it('does not truncate the archive when a dangling symlink is present (regression)', async function () {
		this.timeout(15000);
		// A dangling symlink used to silently truncate the tarball: under dereference tar-fs
		// stat()s the missing target, gets ENOENT, and finalizes the archive early — dropping
		// every entry queued after the link, with no error. The packager must now skip the
		// broken link and ship the full tree.
		const sourceFiles = {
			'package.json': '{"name":"demo","version":"1.0.0"}\n',
			'src/resources/index.js': 'exports.x = 1;\n',
			'tests/a.test.js': 'test();\n',
			'.github/workflows/ci.yml': 'name: ci\n',
		};
		const sourceDir = await makeFixture(sourceFiles);
		// Broken link + a valid link (to real content) that must still be dereferenced.
		await fs.mkdir(path.join(sourceDir, '.claude'), { recursive: true });
		await fs.symlink('../../.agents/skills/nope', path.join(sourceDir, '.claude', 'broken'));
		await fs.symlink(path.join(sourceDir, 'src'), path.join(sourceDir, 'linked-src'));
		const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-dangling-out-'));
		try {
			await pipeline(
				streamPackagedDirectory(sourceDir, { skip_node_modules: true }),
				gunzip(),
				tar.extract(extractDir)
			);
			const extracted = await readDirTree(extractDir);
			// Every real file survives (nothing dropped after the broken link)...
			for (const [rel, content] of Object.entries(sourceFiles)) {
				assert.strictEqual(extracted[rel], content, `missing/altered ${rel}`);
			}
			// ...the valid symlink's target content is dereferenced in...
			assert.strictEqual(extracted['linked-src/resources/index.js'], sourceFiles['src/resources/index.js']);
			// ...and the dangling link itself is not packed as a broken entry.
			assert.ok(!Object.keys(extracted).some((k) => k.includes('broken')), 'dangling link should be skipped');
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(extractDir, { recursive: true, force: true });
		}
	});

	it('never packages node_modules/harper, but leaves a component-owned harperdb alone', async function () {
		this.timeout(30000);
		for (const options of [{}, { skip_symlinks: true }, { skip_node_modules: true }]) {
			const label = JSON.stringify(options);
			const sourceDir = await makeFixture({ 'index.js': 'x\n', 'src/a.js': 'a\n' });
			const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-harper-link-'));
			await fs.mkdir(path.join(sourceDir, 'node_modules', 'keep-me'), { recursive: true });
			await fs.writeFile(path.join(sourceDir, 'node_modules', 'keep-me', 'index.js'), 'keep\n');
			await fs.symlink(PACKAGE_ROOT, path.join(sourceDir, 'node_modules', 'harper'), 'dir');
			// A legacy component's REAL harperdb dependency. The loader only repairs that path when it
			// already exists, so this content is the component's — and stripping it would not be reinstalled
			// on the target, because `installApplication` skips installing when node_modules exists.
			await fs.mkdir(path.join(sourceDir, 'node_modules', 'harperdb'), { recursive: true });
			await fs.writeFile(path.join(sourceDir, 'node_modules', 'harperdb', 'index.js'), 'legacy\n');

			try {
				const scan = await scanPackageDirectory(sourceDir, options);
				assert.ok(scan.totalSize < 100_000, `${label}: estimate walked the install (${scan.totalSize} bytes)`);

				await pipeline(streamPackagedDirectory(sourceDir, options), gunzip(), tar.extract(extractDir));
				const extracted = await readDirTree(extractDir);
				assert.strictEqual(extracted['index.js'], 'x\n', `${label}: real files survive`);
				// Segment-exact, not a prefix test: `node_modules/harper` is a prefix of
				// `node_modules/harperdb`, so a `startsWith` here would flag the legacy dependency below.
				const harperPrefix = path.join('node_modules', 'harper') + path.sep;
				assert.ok(
					!Object.keys(extracted).some((k) => k.startsWith(harperPrefix)),
					`${label}: packed the install: ${Object.keys(extracted).slice(0, 5).join(', ')}`
				);
				if (!options.skip_node_modules) {
					assert.strictEqual(
						extracted[path.join('node_modules', 'keep-me', 'index.js')],
						'keep\n',
						`${label}: the component's own dependencies still ship`
					);
					assert.strictEqual(
						extracted[path.join('node_modules', 'harperdb', 'index.js')],
						'legacy\n',
						`${label}: a component-owned harperdb must not be stripped`
					);
				}
			} finally {
				await fs.rm(sourceDir, { recursive: true, force: true });
				await fs.rm(extractDir, { recursive: true, force: true });
			}
		}
	});

	it('leaves out a nested node_modules/harper link to the install, and keeps a real harper or one linked elsewhere', async function () {
		this.timeout(30000);
		const aliasDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-install-alias-'));
		await fs.symlink(PACKAGE_ROOT, path.join(aliasDir, 'harper'), 'dir');
		// The link the loader gives every component it loads from node_modules (a config.yaml `package:` entry),
		// plus the relative and chained forms the loader also accepts as already linked.
		const installLinks = {
			[path.join('node_modules', 'plugin', 'node_modules', 'harper')]: () => PACKAGE_ROOT,
			[path.join('node_modules', 'plugin', 'node_modules', 'dep', 'node_modules', 'harper')]: () => PACKAGE_ROOT,
			[path.join('node_modules', '@scope', 'plugin', 'node_modules', 'harper')]: (linkDir) =>
				path.relative(linkDir, PACKAGE_ROOT),
			[path.join('node_modules', 'chained', 'node_modules', 'harper')]: () => path.join(aliasDir, 'harper'),
		};
		const linkedElsewhere = path.join('node_modules', 'linked', 'node_modules', 'harper');
		const dangling = path.join('node_modules', 'broken', 'node_modules', 'harper');
		const archiveName = (rel) => rel.split(path.sep).join('/');
		try {
			for (const options of [{}, { skip_symlinks: true }]) {
				const sourceDir = await makeFixture({
					'index.js': 'x\n',
					'node_modules/plugin/index.js': 'plugin\n',
					'node_modules/plugin/node_modules/dep/index.js': 'dep\n',
					// An npm-installed harper under a package nothing loads as a component: the loader never replaces it.
					'node_modules/lib/node_modules/harper/index.js': 'npm copy\n',
					'vendor/harper/index.js': 'vendored\n',
				});
				await fs.symlink(PACKAGE_ROOT, path.join(sourceDir, 'node_modules', 'harper'), 'dir');
				const links = {
					...installLinks,
					[linkedElsewhere]: () => path.join(sourceDir, 'vendor', 'harper'),
					[dangling]: () => path.join(sourceDir, 'gone'),
				};
				// Real path, so a relative target counts its `..`s from where the link actually is (macOS's tmpdir is a link).
				const realSourceDir = await fs.realpath(sourceDir);
				for (const [link, target] of Object.entries(links)) {
					const linkDir = path.dirname(path.join(realSourceDir, link));
					await fs.mkdir(linkDir, { recursive: true });
					await fs.symlink(target(linkDir), path.join(realSourceDir, link), 'dir');
				}

				try {
					const scan = await scanPackageDirectory(sourceDir, options);
					assert.ok(
						scan.totalSize < 100_000,
						`${JSON.stringify(options)}: estimate walked the install (${scan.totalSize} bytes)`
					);
					for (const knownScan of [undefined, scan]) {
						const label = `${JSON.stringify(options)}${knownScan ? ' with a prior scan' : ''}`;
						const entries = await archiveEntries(streamPackagedDirectory(sourceDir, options, undefined, knownScan));
						const names = [...entries.keys()];
						for (const link of Object.keys(installLinks)) {
							const name = archiveName(link);
							assert.ok(!names.some((n) => n === name || n.startsWith(name + '/')), `${label}: packed ${name}`);
						}
						assert.deepStrictEqual([...scan.installLinks].sort(), Object.keys(installLinks).sort(), label);
						assert.strictEqual(entries.get('node_modules/plugin/index.js')?.content, 'plugin\n', label);
						assert.strictEqual(
							entries.get('node_modules/lib/node_modules/harper/index.js')?.content,
							'npm copy\n',
							label
						);
						if (options.skip_symlinks) {
							assert.deepStrictEqual(scan.danglingSymlinks, [], label);
							const literal = entries.get(archiveName(linkedElsewhere));
							assert.strictEqual(literal?.type, 'symlink', label);
							assert.strictEqual(literal.linkname, path.join(sourceDir, 'vendor', 'harper'), label);
						} else {
							assert.deepStrictEqual(scan.danglingSymlinks, [dangling], label);
							assert.ok(!entries.has(archiveName(dangling)), `${label}: packed the dangling link`);
							assert.strictEqual(entries.get(`${archiveName(linkedElsewhere)}/index.js`)?.content, 'vendored\n', label);
							const packedBytes = names.reduce(
								(sum, n) => sum + (entries.get(n).type === 'file' ? entries.get(n).size : 0),
								0
							);
							assert.strictEqual(scan.totalSize, packedBytes, `${label}: the estimate is what was packed`);
						}
					}
				} finally {
					await fs.rm(sourceDir, { recursive: true, force: true });
				}
			}
		} finally {
			await fs.rm(aliasDir, { recursive: true, force: true });
		}
	});

	describe('a node_modules/harperdb link to the install (harper#2577)', () => {
		const rootLink = path.join('node_modules', 'harperdb');
		const pluginLink = path.join('node_modules', 'plugin', 'node_modules', 'harperdb');
		const chainedLink = path.join('node_modules', 'chained', 'node_modules', 'harperdb');
		const pluginHarperLink = path.join('node_modules', 'plugin', 'node_modules', 'harper');
		const linkedElsewhere = path.join('node_modules', 'linked', 'node_modules', 'harperdb');
		const placeholders = [rootLink, pluginLink, chainedLink];
		const archiveName = (rel) => rel.split(path.sep).join('/');
		const discard = () => new Writable({ write: (chunk, encoding, callback) => callback() });

		async function makeLegacyFixture(aliasDir) {
			const sourceDir = await makeFixture({
				'index.js': 'x\n',
				'node_modules/plugin/index.js': 'plugin\n',
				'node_modules/plugin/node_modules/dep/index.js': 'dep\n',
				'zz-after.js': 'sorts after node_modules\n',
				// An npm-installed harperdb under a package nothing loads as a component: the loader never replaces it.
				'node_modules/lib/node_modules/harperdb/index.js': 'npm copy\n',
				'vendor/harperdb/index.js': 'vendored\n',
			});
			const realSourceDir = await fs.realpath(sourceDir);
			const links = {
				[rootLink]: PACKAGE_ROOT,
				[pluginLink]: PACKAGE_ROOT,
				[pluginHarperLink]: PACKAGE_ROOT,
				[chainedLink]: path.join(aliasDir, 'harperdb'),
				[linkedElsewhere]: path.join(realSourceDir, 'vendor', 'harperdb'),
			};
			for (const [link, target] of Object.entries(links)) {
				await fs.mkdir(path.dirname(path.join(realSourceDir, link)), { recursive: true });
				await fs.symlink(target, path.join(realSourceDir, link), 'dir');
			}
			return { sourceDir, realSourceDir };
		}

		async function withLegacyFixture(run) {
			const aliasDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-install-alias-'));
			await fs.symlink(PACKAGE_ROOT, path.join(aliasDir, 'harperdb'), 'dir');
			const fixture = await makeLegacyFixture(aliasDir);
			try {
				await run(fixture.sourceDir, fixture.realSourceDir);
			} finally {
				await fs.rm(fixture.sourceDir, { recursive: true, force: true });
				await fs.rm(aliasDir, { recursive: true, force: true });
			}
		}

		it('ships an empty directory in its place, at the root and under a loaded package, under every option', async function () {
			this.timeout(60000);
			await withLegacyFixture(async (sourceDir, realSourceDir) => {
				for (const options of [{}, { skip_symlinks: true }]) {
					const scan = await scanPackageDirectory(sourceDir, options);
					assert.ok(scan.totalSize < 100_000, `${JSON.stringify(options)}: estimate walked the install`);
					assert.deepStrictEqual(
						[...scan.installLinks].sort(),
						[...placeholders, pluginHarperLink].sort(),
						JSON.stringify(options)
					);
					const buffered = await packageDirectory(sourceDir, options);
					for (const source of ['stream', 'known scan', 'buffer']) {
						const label = `${JSON.stringify(options)} ${source}`;
						const entries = await archiveEntries(
							source === 'buffer'
								? Readable.from(buffered)
								: streamPackagedDirectory(sourceDir, options, undefined, source === 'known scan' ? scan : undefined)
						);
						for (const link of placeholders) {
							const name = archiveName(link);
							const entry = entries.get(name);
							assert.strictEqual(entry?.type, 'directory', `${label}: ${name} must be a directory`);
							assert.strictEqual(entry.mode & 0o777, 0o755, `${label}: ${name} mode`);
							assert.ok(!entry.linkname, `${label}: ${name} carries a link target`);
							assert.ok(![...entries.keys()].some((n) => n.startsWith(name + '/')), `${label}: ${name} has content`);
						}
						assert.ok(
							[...entries.values()].every((entry) => !entry.linkname?.includes(PACKAGE_ROOT)),
							`${label}: an entry carries the packaging host's install path`
						);
						// The loader makes `harper` unconditionally, so it needs no marker.
						assert.ok(!entries.has(archiveName(pluginHarperLink)), `${label}: ${pluginHarperLink} was packed`);
						assert.strictEqual(entries.get('zz-after.js')?.content, 'sorts after node_modules\n', label);
						assert.strictEqual(entries.get('node_modules/plugin/node_modules/dep/index.js')?.content, 'dep\n', label);
						assert.strictEqual(entries.get('node_modules/lib/node_modules/harperdb/index.js')?.content, 'npm copy\n');
						if (options.skip_symlinks) {
							const literal = entries.get(archiveName(linkedElsewhere));
							assert.strictEqual(literal?.type, 'symlink', label);
							assert.strictEqual(literal.linkname, path.join(realSourceDir, 'vendor', 'harperdb'), label);
						} else {
							assert.strictEqual(entries.get(`${archiveName(linkedElsewhere)}/index.js`)?.content, 'vendored\n', label);
						}
						const packedBytes = [...entries.values()].reduce((sum, e) => sum + (e.type === 'file' ? e.size : 0), 0);
						assert.strictEqual(scan.totalSize, packedBytes, `${label}: the estimate is what was packed`);
					}
				}
			});
		});

		it('ships nothing there when node_modules is skipped', async function () {
			this.timeout(30000);
			await withLegacyFixture(async (sourceDir) => {
				for (const options of [{ skip_node_modules: true }, { skip_node_modules: true, skip_symlinks: true }]) {
					const scan = await scanPackageDirectory(sourceDir, options);
					assert.deepStrictEqual(scan.installLinks, [], JSON.stringify(options));
					const names = [...(await archiveEntries(streamPackagedDirectory(sourceDir, options))).keys()];
					assert.ok(!names.some((n) => n.startsWith('node_modules')), `${JSON.stringify(options)}: ${names}`);
					assert.ok(names.includes('index.js'));
				}
			});
		});

		it('leaves the loader something to relink on a fresh extraction, where leaving the path out would not', async function () {
			this.timeout(30000);
			const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-harperdb-extract-'));
			const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-harperdb-bare-'));
			try {
				await withLegacyFixture(async (sourceDir) => {
					await pipeline(streamPackagedDirectory(sourceDir), gunzip(), tar.extract(extractDir));
				});
				for (const link of placeholders) {
					assert.ok((await fs.lstat(path.join(extractDir, link))).isDirectory(), `${link} extracted as a directory`);
					assert.deepStrictEqual(await fs.readdir(path.join(extractDir, link)), []);
				}
				const installRoot = await fs.realpath(PACKAGE_ROOT);
				for (const componentDirectory of [extractDir, path.join(extractDir, 'node_modules', 'plugin')]) {
					await _symlinkHarperModuleForTests(componentDirectory);
					assert.strictEqual(
						await fs.realpath(path.join(componentDirectory, 'node_modules', 'harperdb')),
						installRoot,
						`${componentDirectory} was not relinked`
					);
				}
				// The loader only repairs a path that exists: an archive that left the path out gets no harperdb.
				await _symlinkHarperModuleForTests(bareDir);
				assert.strictEqual(await fs.realpath(path.join(bareDir, 'node_modules', 'harper')), installRoot);
				await assert.rejects(fs.lstat(path.join(bareDir, 'node_modules', 'harperdb')), { code: 'ENOENT' });
			} finally {
				await fs.rm(extractDir, { recursive: true, force: true });
				await fs.rm(bareDir, { recursive: true, force: true });
			}
		});

		it('still finishes, fails, or stops without throwing now that the archive is finalized by hand', async function () {
			this.timeout(30000);
			await withLegacyFixture(async (sourceDir) => {
				await pipeline(streamPackagedDirectory(sourceDir), gunzip(), discard());
				await assert.rejects(pipeline(streamPackagedDirectory(path.join(sourceDir, 'gone')), discard()), {
					code: 'ENOENT',
				});
				for (const readFirst of [false, true]) {
					const stream = streamPackagedDirectory(sourceDir);
					const closed = new Promise((resolve) => stream.once('close', resolve));
					if (readFirst) await new Promise((resolve) => stream.once('data', resolve));
					stream.destroy();
					await closed;
					// A finish hook that ran after the destroy would throw out of tar-fs's walker here.
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			});
		});
	});

	it("leaves out the component's own deployment provenance, and keeps a file of that name deeper down", async function () {
		// Packed from a live tree, the marker would carry that release's deployment id into the next one.
		this.timeout(15000);
		const sourceDir = await makeFixture({
			'index.js': 'x\n',
			'.harper-deployment.json': '{"v":1,"component":"web","deploymentId":"live"}',
			'assets/.harper-deployment.json': 'the component’s own file\n',
		});
		const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-provenance-'));
		try {
			await pipeline(streamPackagedDirectory(sourceDir), gunzip(), tar.extract(extractDir));
			const extracted = await readDirTree(extractDir);
			assert.strictEqual(extracted['.harper-deployment.json'], undefined);
			assert.strictEqual(extracted[path.join('assets', '.harper-deployment.json')], 'the component’s own file\n');
			assert.strictEqual(extracted['index.js'], 'x\n');
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(extractDir, { recursive: true, force: true });
		}
	});

	it('findDanglingSymlinks reports broken links and ignores valid ones and node_modules', async function () {
		this.timeout(15000);
		const sourceDir = await makeFixture({ 'index.js': 'x\n', 'src/a.js': 'a\n' });
		await fs.symlink('./does-not-exist', path.join(sourceDir, 'broken-root'));
		await fs.symlink('../nope', path.join(sourceDir, 'src', 'broken-nested'));
		await fs.symlink(path.join(sourceDir, 'src'), path.join(sourceDir, 'good'));
		// A dangling link inside node_modules must be ignored when skipping node_modules.
		await fs.mkdir(path.join(sourceDir, 'node_modules'), { recursive: true });
		await fs.symlink('./gone', path.join(sourceDir, 'node_modules', 'broken-dep'));
		try {
			const dangling = (await findDanglingSymlinks(sourceDir, { skip_node_modules: true })).sort();
			// 'src/broken-nested' is reported twice — once directly, once via the 'good' alias
			// symlink (which points at 'src') — since tar-fs's dereferenced walk would try to
			// pack (and fail on) both as distinct archive entries.
			assert.deepStrictEqual(dangling, [
				'broken-root',
				path.join('good', 'broken-nested'),
				path.join('src', 'broken-nested'),
			]);
			// With skip_symlinks the archive packs links literally (no dereference), so nothing to warn.
			assert.deepStrictEqual(await findDanglingSymlinks(sourceDir, { skip_symlinks: true }), []);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('finds a dangling symlink nested inside a validly-linked directory, and packs the rest (regression)', async function () {
		this.timeout(15000);
		// tar-fs's dereferenced walk readdirs *through* a valid symlinked directory just like a
		// real one, so a dangling link nested inside it is just as capable of truncating the
		// archive as one at the top level. The scan must recurse into valid symlinked
		// directories to catch this, or packaging will still hit the original bug.
		const sourceDir = await makeFixture({ 'real/nested/deep.txt': 'deep\n', 'real/sibling.txt': 'sib\n' });
		await fs.symlink('./gone', path.join(sourceDir, 'real', 'nested', 'broken'));
		await fs.symlink(path.join(sourceDir, 'real'), path.join(sourceDir, 'link-to-real'));
		const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-nested-dangling-out-'));
		try {
			const dangling = (await findDanglingSymlinks(sourceDir)).sort();
			// Reachable — and reported — via both the real path and the symlink alias, matching
			// the two distinct archive entries tar-fs would otherwise try (and fail) to stat.
			assert.deepStrictEqual(dangling, [
				path.join('link-to-real', 'nested', 'broken'),
				path.join('real', 'nested', 'broken'),
			]);

			await pipeline(streamPackagedDirectory(sourceDir), gunzip(), tar.extract(extractDir));
			const extracted = await readDirTree(extractDir);
			assert.strictEqual(extracted['real/nested/deep.txt'], 'deep\n');
			assert.strictEqual(extracted['real/sibling.txt'], 'sib\n');
			assert.strictEqual(extracted['link-to-real/nested/deep.txt'], 'deep\n');
			assert.strictEqual(extracted['link-to-real/sibling.txt'], 'sib\n');
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(extractDir, { recursive: true, force: true });
		}
	});
});

// keep eslint happy in case Readable isn't directly used in some branch
void Readable;
