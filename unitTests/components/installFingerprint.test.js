'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
const { ProgressEmitter } = require('#src/server/serverHelpers/progressEmitter');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const {
	fingerprintInstall,
	compareInstallFingerprints,
	describeInstallDrift,
	isInstallFingerprint,
	gitSourceIdentity,
	packedSourceIdentity,
} = require('#src/components/installFingerprint');
const { deployComponent, markInstallComparisons } = require('#src/components/operations');
const { preserveRootConfig } = require('../rootConfigFixture.js');

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const lockfiles = (entries) => ({ lockfiles: entries });

const temporaryDirectories = [];
async function temporaryDirectory(prefix) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}
after(() =>
	Promise.all(
		temporaryDirectories.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
	)
);

describe('install fingerprints', () => {
	describe('fingerprintInstall', () => {
		it('lists nothing for a tree without lockfiles, and carries the source identity it is given', async () => {
			const dir = await temporaryDirectory('fp-none-');
			assert.deepStrictEqual(await fingerprintInstall(dir), lockfiles({}));
			assert.deepStrictEqual(await fingerprintInstall(dir, 'npm:web@1.4.2'), {
				source: 'npm:web@1.4.2',
				lockfiles: {},
			});
		});

		it('hashes each root lockfile by name, in a fixed order, and ignores nested ones', async () => {
			const dir = await temporaryDirectory('fp-several-');
			await fs.writeFile(path.join(dir, 'yarn.lock'), 'yarn');
			await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
			await fs.mkdir(path.join(dir, 'nested'));
			await fs.writeFile(path.join(dir, 'nested', 'pnpm-lock.yaml'), 'nested');
			const fingerprint = await fingerprintInstall(dir);
			assert.deepStrictEqual(Object.keys(fingerprint.lockfiles), ['package-lock.json', 'yarn.lock']);
			assert.strictEqual(fingerprint.lockfiles['package-lock.json'], sha256('{"lockfileVersion":3}'));
			assert.strictEqual(fingerprint.lockfiles['yarn.lock'], sha256('yarn'));
		});

		it('names a lockfile it cannot read by the error, instead of treating it as absent', async () => {
			const dir = await temporaryDirectory('fp-unreadable-');
			await fs.mkdir(path.join(dir, 'package-lock.json'));
			const { lockfiles: found } = await fingerprintInstall(dir);
			assert.deepStrictEqual(Object.keys(found), ['package-lock.json']);
			assert.match(found['package-lock.json'].unreadable, /^E[A-Z]+$/);
		});
	});

	describe('compareInstallFingerprints', () => {
		const own = lockfiles({ 'package-lock.json': DIGEST_A });

		it('matches the same lockfiles, and two trees that have none', () => {
			assert.deepStrictEqual(compareInstallFingerprints(own, lockfiles({ 'package-lock.json': DIGEST_A })), {
				matches: true,
				differs: [],
			});
			assert.deepStrictEqual(compareInstallFingerprints(lockfiles({}), lockfiles({})), { matches: true, differs: [] });
		});

		it('names a lockfile whose digest differs, or that only one side has', () => {
			assert.deepStrictEqual(compareInstallFingerprints(own, lockfiles({ 'package-lock.json': DIGEST_B })), {
				matches: false,
				differs: ['package-lock.json'],
			});
			assert.deepStrictEqual(
				compareInstallFingerprints(own, lockfiles({ 'package-lock.json': DIGEST_A, 'yarn.lock': DIGEST_B })),
				{ matches: false, differs: ['yarn.lock'] }
			);
			assert.deepStrictEqual(compareInstallFingerprints(own, lockfiles({})), {
				matches: false,
				differs: ['package-lock.json'],
			});
		});

		it('knows nothing when a lockfile both sides have cannot be read, unless another one differs', () => {
			const unreadable = lockfiles({ 'package-lock.json': { unreadable: 'EACCES' } });
			assert.deepStrictEqual(compareInstallFingerprints(own, unreadable), { matches: null, differs: [] });
			assert.deepStrictEqual(
				compareInstallFingerprints(lockfiles({ ...own.lockfiles, 'yarn.lock': DIGEST_A }), unreadable),
				{ matches: false, differs: ['yarn.lock'] }
			);
		});

		it('knows nothing without usable evidence from both sides', () => {
			for (const peer of [
				undefined,
				null,
				'x',
				{},
				lockfiles('x'),
				lockfiles({ 'package-lock.json': 'not-a-digest' }),
			]) {
				assert.deepStrictEqual(compareInstallFingerprints(own, peer), { matches: null, differs: [] });
			}
			assert.deepStrictEqual(compareInstallFingerprints(undefined, own), { matches: null, differs: [] });
		});

		it('ignores a lockfile name this node does not recognize', () => {
			assert.deepStrictEqual(
				compareInstallFingerprints(own, lockfiles({ 'package-lock.json': DIGEST_A, 'deno.lock': DIGEST_B })),
				{ matches: true, differs: [] }
			);
		});

		it('compares the source both sides name, and knows nothing when only one names it', () => {
			const withSource = (source) => ({ source, lockfiles: own.lockfiles });
			assert.deepStrictEqual(compareInstallFingerprints(withSource('npm:web@1.4.2'), withSource('npm:web@1.4.2')), {
				matches: true,
				differs: [],
			});
			assert.deepStrictEqual(compareInstallFingerprints(withSource('npm:web@1.4.2'), withSource('npm:web@1.5.0')), {
				matches: false,
				differs: ['source'],
				peerSource: 'npm:web@1.5.0',
			});
			assert.deepStrictEqual(compareInstallFingerprints(withSource('npm:web@1.4.2'), own), {
				matches: null,
				differs: [],
			});
		});

		it('never matches a source the resolver could not name, on either side', () => {
			const withSource = (source) => ({ source, lockfiles: {} });
			for (const [mine, theirs] of [
				['unidentified', 'unidentified'],
				['unidentified', 'npm:web@1.4.2'],
				['npm:web@1.4.2', 'unidentified'],
			]) {
				assert.deepStrictEqual(compareInstallFingerprints(withSource(mine), withSource(theirs)), {
					matches: null,
					differs: [],
				});
			}
		});
	});

	it('names a source the way its resolver already identified it, or says it could not', () => {
		const commit = 'c'.repeat(40);
		assert.strictEqual(gitSourceIdentity(`${commit}\n`), `git:${commit}`);
		assert.strictEqual(gitSourceIdentity('d'.repeat(64)), `git:${'d'.repeat(64)}`);
		for (const notACommit of [undefined, '', 'main', 'c'.repeat(39)]) {
			assert.strictEqual(gitSourceIdentity(notACommit), 'unidentified');
		}
		const packed = { name: '@scope/web', version: '1.4.2', integrity: 'sha512-abc' };
		assert.strictEqual(packedSourceIdentity(true, packed), 'npm:@scope/web@1.4.2');
		assert.strictEqual(packedSourceIdentity(false, packed), 'integrity:sha512-abc');
		assert.strictEqual(packedSourceIdentity(true, { integrity: 'sha512-abc' }), 'unidentified');
		assert.strictEqual(packedSourceIdentity(false, { name: 'web', version: '1.4.2' }), 'unidentified');
	});

	it('isInstallFingerprint accepts digests, unreadable markers and named sources only', () => {
		assert.ok(isInstallFingerprint(lockfiles({ 'yarn.lock': DIGEST_A, 'bun.lock': { unreadable: 'EIO' } })));
		assert.ok(isInstallFingerprint({ source: `git:${'c'.repeat(40)}`, lockfiles: {} }));
		assert.ok(isInstallFingerprint({ source: 'unidentified', lockfiles: {} }));
		assert.ok(!isInstallFingerprint(lockfiles({ 'yarn.lock': DIGEST_A.toUpperCase() })));
		assert.ok(!isInstallFingerprint(lockfiles({ 'yarn.lock': { unreadable: 5 } })));
		assert.ok(!isInstallFingerprint(lockfiles([DIGEST_A])));
		assert.ok(!isInstallFingerprint({ source: 'https://token@example.com/web.tgz', lockfiles: {} }));
	});

	it('describeInstallDrift names only the peers whose fingerprints differ, with a differing source', () => {
		const same = { matches: true, differs: [] };
		const unknown = { matches: null, differs: [] };
		const differs = { matches: false, differs: ['source', 'package-lock.json'], peerSource: 'npm:web@1.5.0' };
		assert.strictEqual(describeInstallDrift([{ node: 'b', comparison: same }]), undefined);
		assert.strictEqual(
			describeInstallDrift([
				{ node: 'b', comparison: same },
				{ node: 'c', comparison: differs },
				{ node: null, comparison: unknown },
			]),
			"Install fingerprints differ from this node's on 1 of 3 peer node(s): c (source npm:web@1.5.0, package-lock.json)."
		);
	});

	it('markInstallComparisons marks every peer entry, reading a wrapped body too', () => {
		const own = lockfiles({ 'package-lock.json': DIGEST_A });
		const replicated = [
			{ node: 'same', install: own },
			{ node: 'wrapped', value: { install: lockfiles({ 'package-lock.json': DIGEST_B }) } },
			{ node: 'old', message: 'Successfully deployed: web' },
			{ node: 'down', status: 'failed', reason: 'socket closed' },
			null,
		];
		assert.strictEqual(
			markInstallComparisons(own, replicated),
			"Install fingerprints differ from this node's on 1 of 4 peer node(s): wrapped (package-lock.json)."
		);
		assert.deepStrictEqual(
			replicated.slice(0, 4).map((peer) => [peer.node, peer.install_matches, peer.install_differs]),
			[
				['same', true, []],
				['wrapped', false, ['package-lock.json']],
				['old', null, []],
				['down', null, []],
			]
		);
		assert.strictEqual(markInstallComparisons(undefined, replicated), undefined);
		assert.strictEqual(markInstallComparisons(own, undefined), undefined);
	});

	describe('a replicated deploy', function () {
		this.timeout(30_000);
		const PROJECT = 'install-fingerprint-app';
		const LOCKFILE = '{"name":"install-fingerprint-app","lockfileVersion":3,"packages":{}}\n';
		const OWN = lockfiles({ 'package-lock.json': sha256(LOCKFILE) });
		let priorComponentsRoot;
		let originalReplicateOperation;
		let payload;
		let peers;

		before(async () => {
			priorComponentsRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
			env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, await temporaryDirectory('fp-root-'));
			const sourceDir = await temporaryDirectory('fp-src-');
			await fs.writeFile(path.join(sourceDir, 'resources.js'), 'export {};\n');
			await fs.writeFile(path.join(sourceDir, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
			await fs.writeFile(path.join(sourceDir, 'package-lock.json'), LOCKFILE);
			payload = (await packageDirectory(sourceDir, { skip_node_modules: true })).toString('base64');
			originalReplicateOperation = server.replication.replicateOperation;
			server.replication.replicateOperation = async () => ({ message: '', replicated: peers() });
		});

		after(() => {
			server.replication.replicateOperation = originalReplicateOperation;
			env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, priorComponentsRoot);
			// A first deploy of a component asks for a restart, which this process never performs.
			resetRestartNeeded();
		});

		async function deploy(extra = {}) {
			const progress = new ProgressEmitter();
			const warnings = [];
			progress.subscribe(({ event, data }) => event === 'warning' && warnings.push(data));
			const request = {
				operation: 'deploy_component',
				project: PROJECT,
				payload,
				replicated: true,
				progress,
				...extra,
			};
			// A stage refuses `restart` in any form.
			if (request.activate !== false) request.restart = false;
			try {
				return { response: await deployComponent(request), warnings };
			} catch (error) {
				return { error, warnings };
			}
		}

		it("reports the origin's fingerprint, marks every peer, and names the one that differs", async () => {
			peers = () => [
				{ node: 'same', install: OWN, message: `Successfully deployed: ${PROJECT}` },
				{ node: 'other', install: lockfiles({ 'package-lock.json': DIGEST_B }) },
				{ node: 'old', message: `Successfully deployed: ${PROJECT}` },
			];
			const { response, warnings, error } = await deploy();
			assert.ifError(error);
			const drift = "Install fingerprints differ from this node's on 1 of 3 peer node(s): other (package-lock.json).";
			assert.deepStrictEqual(response.install, OWN);
			assert.strictEqual(response.message, `Successfully deployed: ${PROJECT} ${drift}`);
			assert.deepStrictEqual(warnings, [{ message: drift }]);
			assert.deepStrictEqual(
				response.replicated.map((peer) => [peer.node, peer.install_matches]),
				[
					['same', true],
					['other', false],
					['old', null],
				]
			);
		});

		it('leaves the message alone when every peer matches', async () => {
			peers = () => [{ node: 'same', install: OWN }];
			const { response, warnings, error } = await deploy();
			assert.ifError(error);
			assert.strictEqual(response.message, `Successfully deployed: ${PROJECT}`);
			assert.deepStrictEqual(warnings, []);
		});

		it("keeps the sentence after a stage's own message", async () => {
			peers = () => [{ node: 'other', install: lockfiles({}), staged: true }];
			const { response, error } = await deploy({ activate: false });
			assert.ifError(error);
			assert.match(
				response.message,
				new RegExp(
					`^Staged: ${PROJECT}\\. Deploy it with deploy_component deployment_id=\\S+ ` +
						"Install fingerprints differ from this node's on 1 of 1 peer node\\(s\\): other \\(package-lock\\.json\\)\\.$"
				)
			);
		});

		it('warns before a real peer failure fails the deploy, which the drift alone never does', async () => {
			peers = () => [
				{ node: 'other', install: lockfiles({ 'package-lock.json': DIGEST_B }) },
				{ node: 'down', status: 'failed', reason: 'socket closed' },
			];
			const { error, warnings } = await deploy();
			assert.match(error?.message ?? '', /failed to replicate to 1 of 2 peer node\(s\): down \(socket closed\)/);
			assert.deepStrictEqual(
				warnings.map((warning) => warning.message),
				["Install fingerprints differ from this node's on 1 of 2 peer node(s): other (package-lock.json)."]
			);
			const masked = await deploy({ ignore_replication_errors: true });
			assert.ifError(masked.error);
			assert.match(
				masked.response.message,
				/^Successfully deployed: install-fingerprint-app Install fingerprints differ/
			);
		});

		describe('from a git reference', function () {
			// A package deploy publishes the component's root-config entry.
			preserveRootConfig();
			let packageIdentifier;
			let commit;

			before(async function () {
				if (process.platform === 'win32' || !gitAvailable()) return this.skip();
				const work = await temporaryDirectory('fp-git-work-');
				await fs.writeFile(path.join(work, 'resources.js'), 'export {};\n');
				await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
				const git = (...args) =>
					execFileSync(
						'git',
						['-c', 'user.email=test@harperdb.io', '-c', 'user.name=Harper Test', '-c', 'commit.gpgsign=false', ...args],
						{ cwd: work, stdio: 'pipe' }
					);
				git('init', '--quiet', '--initial-branch=main');
				git('add', '.');
				git('commit', '--quiet', '-m', 'initial');
				commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
				packageIdentifier = `git+file://${work}`;
			});

			it('names the commit it cloned as the source, and a peer on another commit by it', async () => {
				const elsewhere = `git:${'e'.repeat(40)}`;
				peers = () => [{ node: 'moved', install: { source: elsewhere, lockfiles: {} } }];
				const { response, error } = await deploy({ payload: undefined, package: packageIdentifier });
				assert.ifError(error);
				assert.deepStrictEqual(response.install, { source: `git:${commit}`, lockfiles: {} });
				assert.match(response.message, new RegExp(`moved \\(source ${elsewhere}\\)\\.$`));
			});

			it('lets npm name what it packed itself, once install scripts are allowed', async () => {
				peers = () => [];
				const { response, error } = await deploy({
					payload: undefined,
					package: packageIdentifier,
					install_allow_scripts: true,
				});
				assert.ifError(error);
				assert.match(response.install.source, /^integrity:sha512-/);
			});
		});

		describe('from a local path', function () {
			// A package deploy publishes the component's root-config entry.
			preserveRootConfig();
			let directory;
			let tarball;

			before(async () => {
				directory = await temporaryDirectory('fp-local-dir-');
				await fs.writeFile(path.join(directory, 'resources.js'), 'export {};\n');
				await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
				tarball = path.join(await temporaryDirectory('fp-local-tgz-'), 'component.tgz');
				await fs.writeFile(tarball, await packageDirectory(directory, { skip_node_modules: true }));
			});

			it('never matches a peer on a local file: path, which each node reads its own copy of', async () => {
				peers = () => [{ node: 'local', install: { source: 'unidentified', lockfiles: {} } }];
				for (const local of [directory, tarball]) {
					const { response, error } = await deploy({ payload: undefined, package: `file:${local}` });
					assert.ifError(error);
					assert.deepStrictEqual(response.install, { source: 'unidentified', lockfiles: {} }, local);
					assert.strictEqual(response.replicated[0].install_matches, null, local);
					assert.strictEqual(response.message, `Successfully deployed: ${PROJECT}`, local);
				}
			});
		});
	});
});

function gitAvailable() {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}
