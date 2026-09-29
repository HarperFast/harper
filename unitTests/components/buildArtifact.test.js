'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const tar = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	inventoryBuild,
	platformRefusal,
	isBuildManifest,
	packBuild,
	verifiedArchive,
	hostPlatform,
} = require('#src/components/buildArtifact');
const { DEPLOYMENT_PROVENANCE_FILE } = require('#src/components/deploymentProvenance');

const onWindows = process.platform === 'win32';

async function tree(files, label = 'tree') {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `build-artifact-${label}-`));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		if (content && typeof content === 'object' && !Buffer.isBuffer(content)) {
			if (content.dir) await fs.mkdir(full, { recursive: true });
			else if (content.link) await fs.symlink(content.link, full);
			else {
				await fs.writeFile(full, content.content ?? '');
				if (content.mode) await fs.chmod(full, content.mode);
			}
		} else {
			await fs.writeFile(full, content);
		}
	}
	return root;
}

const digestOf = async (root) => (await inventoryBuild(root)).tree;

describe('build manifests', () => {
	describe('the tree digest', () => {
		it('is the same for the same tree and changes with any file, directory, or exec bit', async function () {
			const base = { 'package.json': '{}', 'src/index.js': 'v1', 'src/empty/': { dir: true } };
			const first = await tree(base);
			const second = await tree(base);
			assert.strictEqual(await digestOf(first), await digestOf(second), 'built twice, same identity');

			const edited = await tree({ ...base, 'src/index.js': 'v2' });
			const extraDir = await tree({ ...base, 'more/': { dir: true } });
			assert.notStrictEqual(await digestOf(edited), await digestOf(first), 'a content change');
			assert.notStrictEqual(await digestOf(extraDir), await digestOf(first), 'an empty directory');
			if (!onWindows) {
				const executable = await tree({ ...base, 'src/index.js': { content: 'v1', mode: 0o755 } });
				assert.notStrictEqual(await digestOf(executable), await digestOf(first), 'the owner-exec bit');
			}
		});

		it('covers link targets without following them', async function () {
			if (onWindows) this.skip();
			const one = await tree({ 'a.js': 'a', 'b.js': 'b', 'link.js': { link: 'a.js' } });
			const other = await tree({ 'a.js': 'a', 'b.js': 'b', 'link.js': { link: 'b.js' } });
			assert.notStrictEqual(await digestOf(one), await digestOf(other));
			const dangling = await tree({ 'link.js': { link: 'nowhere/at/all' } });
			assert.match(await digestOf(dangling), /^[0-9a-f]{64}$/, 'a dangling link is recorded, not read');
		});

		it('leaves out the provenance marker and the loader-owned links, and records only that harperdb is there', async function () {
			const base = { 'index.js': 'x', 'node_modules/dep/index.js': 'dep' };
			const plain = await digestOf(await tree(base));
			assert.strictEqual(
				await digestOf(await tree({ ...base, [DEPLOYMENT_PROVENANCE_FILE]: '{"v":1}' })),
				plain,
				'the marker every node writes for itself'
			);
			assert.strictEqual(
				await digestOf(await tree({ ...base, 'node_modules/harper/index.js': 'the install' })),
				plain,
				'node_modules/harper, which the loader replaces on every load'
			);
			const noDependencies = { 'index.js': 'x' };
			assert.strictEqual(
				await digestOf(await tree({ ...noDependencies, 'node_modules/': { dir: true } })),
				await digestOf(await tree(noDependencies)),
				'nor the node_modules directory every load creates to hold that link'
			);
			const withHarperdb = await digestOf(await tree({ ...base, 'node_modules/harperdb/index.js': 'one' }));
			assert.notStrictEqual(withHarperdb, plain, 'harperdb being present is part of the tree');
			assert.strictEqual(
				await digestOf(await tree({ ...base, 'node_modules/harperdb/index.js': 'another' })),
				withHarperdb,
				'but not what it holds, which the loader re-points'
			);
		});

		it('keeps each record distinct however names are spelled', async function () {
			if (onWindows) this.skip();
			// A line-per-record encoding without escaping reads two directories and one directory named across a line
			// break identically.
			const two = await tree({ 'a/': { dir: true }, 'b/': { dir: true } });
			const one = await tree({ 'a\nD b/': { dir: true } });
			assert.notStrictEqual(await digestOf(two), await digestOf(one));
		});
	});

	describe('platform facts', () => {
		const bindsOf = async (files, options) => (await inventoryBuild(await tree(files), options)).platform.binds;

		it('binds nothing for a tree of plain files', async () => {
			assert.deepStrictEqual(await bindsOf({ 'index.js': 'x', 'node_modules/dep/index.js': 'y' }), {});
		});

		it('binds os, arch and libc to a package npm chose for this platform, naming it', async () => {
			const binds = await bindsOf({
				'node_modules/@esbuild/linux-x64/package.json': JSON.stringify({ name: '@esbuild/linux-x64', cpu: ['x64'] }),
				'node_modules/@esbuild/linux-x64/bin/esbuild': 'not really',
			});
			const manifest = 'node_modules/@esbuild/linux-x64/package.json';
			assert.deepStrictEqual(binds, { os: manifest, arch: manifest, libc: manifest });
		});

		it('binds os, arch and libc to native code however it is named', async () => {
			const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(16)]);
			const binds = await bindsOf({ 'bin/tool': elf });
			assert.deepStrictEqual(binds, { os: 'bin/tool', arch: 'bin/tool', libc: 'bin/tool' });
		});

		it('binds the Node ABI only for an addon that links against V8 or node, not a Node-API one', async () => {
			const nodeApi = Buffer.from('\x7fELF.... napi_register_module_v1 napi_create_function');
			const v8 = Buffer.from('\x7fELF.... node_register_module_v137 _ZN2v87Isolate');
			const unclassified = Buffer.from('\x7fELF.... nothing recognisable');
			assert.deepStrictEqual(await bindsOf({ 'addon.node': nodeApi }), {
				os: 'addon.node',
				arch: 'addon.node',
				libc: 'addon.node',
			});
			assert.strictEqual((await bindsOf({ 'addon.node': v8 })).abi, 'addon.node');
			assert.strictEqual((await bindsOf({ 'addon.node': unclassified })).abi, 'addon.node', 'unknown binds');
		});

		it('binds everything to an install nothing can inspect', async () => {
			const binds = await bindsOf({ 'index.js': 'x' }, { uninspectableInstall: 'install_command' });
			assert.deepStrictEqual(binds, {
				os: 'install_command',
				arch: 'install_command',
				libc: 'install_command',
				abi: 'install_command',
			});
		});

		it('binds POSIX semantics to a link or an executable file', async function () {
			if (onWindows) this.skip();
			assert.deepStrictEqual(await bindsOf({ 'run.sh': { content: '#!/bin/sh', mode: 0o755 } }), { posix: 'run.sh' });
			assert.deepStrictEqual(await bindsOf({ 'a.js': 'a', 'link.js': { link: 'a.js' } }), { posix: 'link.js' });
		});

		it('names the same binding path however the walk interleaves', async () => {
			const files = {};
			for (let index = 0; index < 50; index++) {
				files[`node_modules/p${String(index).padStart(2, '0')}/package.json`] = JSON.stringify({ os: ['linux'] });
			}
			for (let attempt = 0; attempt < 3; attempt++) {
				assert.strictEqual((await bindsOf(files)).os, 'node_modules/p00/package.json');
			}
		});
	});

	describe('refusing a build this node cannot run', () => {
		const built = (binds, overrides = {}) => ({
			os: 'linux',
			arch: 'x64',
			libc: 'glibc',
			abi: '137',
			binds,
			...overrides,
		});
		const here = { os: 'linux', arch: 'arm64', libc: 'glibc', abi: '141' };

		it('refuses only on the fields the build is bound to, naming why', () => {
			assert.strictEqual(platformRefusal(built({}), here, false), undefined, 'bound to nothing');
			assert.strictEqual(platformRefusal(built({ libc: 'x' }), here, false), undefined, 'bound only where it matches');
			const refusal = platformRefusal(built({ arch: 'node_modules/@esbuild/linux-x64/package.json' }), here, false);
			assert.match(refusal, /CPU architecture x64/);
			assert.match(refusal, /required by node_modules\/@esbuild\/linux-x64\/package\.json/);
			assert.match(refusal, /this node has arm64/);
			assert.doesNotMatch(refusal, /Node ABI/, 'an ABI it is not bound to is not mentioned');
			assert.match(
				platformRefusal(built({ abi: 'a.node', arch: 'a.node' }), here, false),
				/Node ABI 137.*; |; .*Node ABI/
			);
		});

		it('refuses POSIX semantics on Windows', () => {
			const onPosix = platformRefusal(built({ posix: 'node_modules/.bin/x' }), built({}), false);
			const onWin = platformRefusal(built({ posix: 'node_modules/.bin/x' }), built({}), true);
			assert.strictEqual(onPosix, undefined);
			assert.match(onWin, /links and executable permissions \(required by node_modules\/\.bin\/x\)/);
		});

		it('describes the host it runs on', () => {
			const host = hostPlatform();
			assert.strictEqual(host.os, process.platform);
			assert.strictEqual(host.arch, process.arch);
			assert.strictEqual(host.abi, process.versions.modules);
			if (process.platform === 'linux') assert.ok(['glibc', 'musl'].includes(host.libc));
			else assert.strictEqual(host.libc, null);
		});
	});

	describe('validating a manifest from elsewhere', () => {
		const good = { tree: 'a'.repeat(64), platform: { os: 'linux', arch: 'x64', libc: null, abi: '137', binds: {} } };

		it('accepts a complete manifest and refuses anything short of one', () => {
			assert.strictEqual(isBuildManifest(good), true);
			const broken = {
				'no tree': { ...good, tree: undefined },
				'a short tree': { ...good, tree: 'abc' },
				'no platform': { ...good, platform: undefined },
				'a numeric abi': { ...good, platform: { ...good.platform, abi: 137 } },
				'binds as an array': { ...good, platform: { ...good.platform, binds: [] } },
				'an unknown bind': { ...good, platform: { ...good.platform, binds: { gpu: 'x' } } },
				'a non-string bind': { ...good, platform: { ...good.platform, binds: { os: 1 } } },
			};
			for (const [label, manifest] of Object.entries(broken))
				assert.strictEqual(isBuildManifest(manifest), false, label);
		});
	});

	describe('packing and receiving a build', () => {
		async function packed(root) {
			const chunks = [];
			for await (const chunk of packBuild(root)) chunks.push(chunk);
			return Buffer.concat(chunks);
		}

		it('packs links as links, keeps exec bits, and leaves out what the digest leaves out', async function () {
			if (onWindows) this.skip();
			const root = await tree({
				'package.json': '{}',
				'packages/ws/bin/cli.js': { content: '#!/usr/bin/env node', mode: 0o755 },
				'node_modules/ws': { link: '../packages/ws' },
				// A link through a link, which tar-fs refuses to extract unless told otherwise.
				'node_modules/.bin/ws-cli': { link: '../ws/bin/cli.js' },
				'node_modules/harper': { link: os.tmpdir() },
				[DEPLOYMENT_PROVENANCE_FILE]: '{"v":1}',
			});
			const archive = await packed(root);
			const target = await fs.mkdtemp(path.join(os.tmpdir(), 'build-artifact-received-'));
			await pipeline(Readable.from([archive]), zlib.createGunzip(), tar.extract(target, { validateSymlinks: false }));

			assert.strictEqual(await fs.readlink(path.join(target, 'node_modules/ws')), '../packages/ws');
			assert.strictEqual(await fs.readlink(path.join(target, 'node_modules/.bin/ws-cli')), '../ws/bin/cli.js');
			assert.ok((await fs.stat(path.join(target, 'packages/ws/bin/cli.js'))).mode & 0o100, 'still executable');
			await assert.rejects(fs.lstat(path.join(target, 'node_modules/harper')), { code: 'ENOENT' });
			await assert.rejects(fs.lstat(path.join(target, DEPLOYMENT_PROVENANCE_FILE)), { code: 'ENOENT' });
			assert.strictEqual(await digestOf(target), await digestOf(root), 'the tree that arrives is the tree that left');
		});

		it('passes an archive through, and fails at its end when it is not the one published', async () => {
			const bytes = Buffer.from('an archive');
			const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
			const through = [];
			const collect = new Writable({
				write(chunk, _encoding, callback) {
					through.push(chunk);
					callback();
				},
			});
			await pipeline(Readable.from([bytes]), verifiedArchive({ sha256, size: bytes.length }), collect);
			assert.deepStrictEqual(Buffer.concat(through), bytes);

			for (const expected of [
				{ sha256, size: bytes.length + 1 },
				{ sha256: 'f'.repeat(64), size: bytes.length },
			]) {
				const discard = new Writable({ write: (_chunk, _encoding, callback) => callback() });
				await assert.rejects(
					pipeline(Readable.from([bytes]), verifiedArchive(expected), discard),
					(error) => error.statusCode === 409 && /is not the one its origin published/.test(error.message)
				);
			}
		});
	});
});
