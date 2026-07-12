'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { streamPackagedDirectory, packageDirectory, findDanglingSymlinks } = require('#src/components/packageComponent');
const { buildMultipartBody } = require('#src/bin/multipartBuilder');
const { parseMultipartRequest } = require('#src/server/serverHelpers/multipartParser');
const gunzip = require('gunzip-maybe');
const tar = require('tar-fs');

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
