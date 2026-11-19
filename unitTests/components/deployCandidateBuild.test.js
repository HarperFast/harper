'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const { Readable } = require('node:stream');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	buildCandidateApplication,
	candidateApplicationPath,
	DEPLOY_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const { packageDirectory } = require('#src/components/packageComponent');

async function makeTarball(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-src-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return packageDirectory(dir, { skip_node_modules: true });
}

// A live component holding bytes that must survive a candidate build untouched.
async function makeLiveComponent(componentsRoot, name, marker) {
	const dirPath = path.join(componentsRoot, name);
	await fs.mkdir(path.join(dirPath, 'nested'), { recursive: true });
	await fs.writeFile(path.join(dirPath, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`);
	await fs.writeFile(path.join(dirPath, 'index.js'), marker);
	await fs.writeFile(path.join(dirPath, 'nested', 'live-only.txt'), marker);
	return dirPath;
}

describe('deploy candidate builds', () => {
	it('builds the replacement without touching the live tree', async function () {
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-untouched-'));
		const dirPath = await makeLiveComponent(componentsRoot, 'web', 'LIVE v1\n');
		const archive = await makeTarball({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'CANDIDATE v2\n',
		});
		const app = new Application({ name: 'web', payload: archive });
		app.dirPath = dirPath;

		const candidatePath = await buildCandidateApplication(app, 'dep-1');

		assert.strictEqual(
			candidatePath,
			candidateApplicationPath(dirPath, 'dep-1'),
			'the candidate lands at the per-deployment staging path'
		);
		assert.strictEqual(await fs.readFile(path.join(candidatePath, 'index.js'), 'utf8'), 'CANDIDATE v2\n');
		// The point of the whole step: the serving tree is byte-identical afterwards.
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'index.js'), 'utf8'), 'LIVE v1\n');
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'nested', 'live-only.txt'), 'utf8'), 'LIVE v1\n');
		assert.strictEqual(
			JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version,
			'1.0.0',
			'the live package.json still describes the previous release'
		);
		await fs.rm(componentsRoot, { recursive: true, force: true });
	});

	it('closes the git credential socket before any dependency install script can run', async function () {
		if (process.platform === 'win32') return this.skip(); // the credential server is POSIX-socket only
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-credentials-'));
		const dirPath = await makeLiveComponent(componentsRoot, 'web', 'LIVE v1\n');
		const orderFile = path.join(componentsRoot, 'order.log');
		// An install step is arbitrary code from the registry running as this uid. It records the credential
		// sockets it can actually reach, so this asserts unreachability rather than merely call ordering.
		const archive = await makeTarball({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'install-probe.js': [
				`const fs = require('fs'), os = require('os');`,
				`const live = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('harper-git-cred-'));`,
				`fs.appendFileSync(${JSON.stringify(orderFile)}, 'install sockets=' + live.length + '\\n');`,
			].join('\n'),
		});
		const app = new Application({
			name: 'web',
			payload: archive,
			install: { command: 'node install-probe.js' },
			credentials: [{ host: 'git.example.com', token: 'deployer-pat', username: 'deployer' }],
		});
		app.dirPath = dirPath;

		await app.startGitCredentialSession();
		const socketsWhileCloning = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('harper-git-cred-'));
		assert.ok(socketsWhileCloning.length > 0, 'a real credential socket exists during extraction');

		await buildCandidateApplication(app, 'dep-cred');

		const order = (await fs.readFile(orderFile, 'utf8')).split('\n').filter(Boolean);
		assert.strictEqual(order.length, 1, 'the install step ran, so the assertion below is not vacuous');
		assert.strictEqual(order[0], 'install sockets=0', 'no credential socket is reachable from the install');
		await fs.rm(componentsRoot, { recursive: true, force: true });
	});

	it('still fsyncs a file: candidate, tolerating only the foreign files beside it', async function () {
		// chmod cannot make a file unreadable to root, so as root this would assert nothing at all.
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
		this.timeout(20000);
		const { markCandidateComplete } = require('#src/components/Application');
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-filelink-'));
		const dirPath = await makeLiveComponent(componentsRoot, 'web', 'LIVE v1\n');
		// A `file:` candidate is a symlink into a developer's own tree, which can hold a file the Harper uid
		// cannot open. That file is not ours to make durable — but the install output written THROUGH the
		// link is, so the tree still has to be walked.
		const source = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-src-link-'));
		await fs.writeFile(path.join(source, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
		await fs.writeFile(path.join(source, 'node_modules', 'installed.js'), 'INSTALL OUTPUT\n');
		const unreadable = path.join(source, 'private.key');
		await fs.writeFile(unreadable, 'secret');
		await fs.chmod(unreadable, 0o000);

		const deploymentDir = path.join(componentsRoot, '.deploy-staging', 'dep-link');
		await fs.mkdir(deploymentDir, { recursive: true });
		await fs.symlink(source, path.join(deploymentDir, 'web'), 'dir');

		await markCandidateComplete(dirPath, 'dep-link', 'web');

		assert.ok(
			existsSync(path.join(deploymentDir, '.complete')),
			'the deploy is not failed by a file it never wrote and cannot read'
		);
		await fs.chmod(unreadable, 0o600);
		await fs.rm(componentsRoot, { recursive: true, force: true });
		await fs.rm(source, { recursive: true, force: true });
	});

	it('leaves no candidate behind and no mark on the live tree when the build fails', async function () {
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-failed-'));
		const dirPath = await makeLiveComponent(componentsRoot, 'web', 'LIVE v1\n');
		const archive = await makeTarball({ 'package.json': '{"name":"web","version":"2.0.0"}\n' });
		const deliveryError = new Error('payload delivery failed');
		const payload = Readable.from(
			(async function* () {
				yield archive.subarray(0, Math.floor(archive.length / 2));
				throw deliveryError;
			})()
		);
		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		await assert.rejects(() => buildCandidateApplication(app, 'dep-2'), /payload delivery failed/);

		assert.strictEqual(
			existsSync(path.join(componentsRoot, DEPLOY_STAGING_DIR, 'dep-2')),
			false,
			'the abandoned candidate takes its whole deployment directory with it'
		);
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'index.js'), 'utf8'), 'LIVE v1\n');
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'nested', 'live-only.txt'), 'utf8'), 'LIVE v1\n');
		await fs.rm(componentsRoot, { recursive: true, force: true });
	});

	it('replaces a candidate directory left by an earlier attempt on the same id', async function () {
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-retry-'));
		const dirPath = await makeLiveComponent(componentsRoot, 'web', 'LIVE v1\n');
		const stale = candidateApplicationPath(dirPath, 'dep-3');
		await fs.mkdir(stale, { recursive: true });
		await fs.writeFile(path.join(stale, 'stale-only.txt'), 'from the abandoned attempt\n');
		const archive = await makeTarball({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'CANDIDATE v2\n',
		});
		const app = new Application({ name: 'web', payload: archive });
		app.dirPath = dirPath;

		const candidatePath = await buildCandidateApplication(app, 'dep-3');

		assert.strictEqual(await fs.readFile(path.join(candidatePath, 'index.js'), 'utf8'), 'CANDIDATE v2\n');
		assert.strictEqual(
			existsSync(path.join(candidatePath, 'stale-only.txt')),
			false,
			'a retry replaces the earlier attempt rather than extracting on top of it'
		);
		await fs.rm(componentsRoot, { recursive: true, force: true });
	});

	it('refuses a staging path that is a symlink rather than a directory', async function () {
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-symlink-'));
		const dirPath = await makeLiveComponent(componentsRoot, 'web', 'LIVE v1\n');
		const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-elsewhere-'));
		// Stand in for an attacker swapping the staging root for a link out of the components root.
		await fs.symlink(elsewhere, path.join(componentsRoot, DEPLOY_STAGING_DIR), 'dir');
		const archive = await makeTarball({ 'package.json': '{"name":"web","version":"2.0.0"}\n' });
		const app = new Application({ name: 'web', payload: archive });
		app.dirPath = dirPath;

		await assert.rejects(
			() => buildCandidateApplication(app, 'dep-4'),
			/Component deploy staging path is not a directory/,
			'extraction never runs through a substituted staging path'
		);
		assert.strictEqual((await fs.readdir(elsewhere)).length, 0, 'and nothing was written outside the components root');
		await fs.rm(componentsRoot, { recursive: true, force: true });
		await fs.rm(elsewhere, { recursive: true, force: true });
	});
});
