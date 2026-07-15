'use strict';

// Covers resolving an npm-style `semver:<range>` committish to a concrete tag before `git checkout`
// (#1797 follow-up). #1799's own worked example (`github:my-org/my-app#semver:v1.2.3`) documented this
// form, but `packGitReferenceWithoutScripts` passed the committish straight to `git checkout`
// unconditionally — which has no notion of npm's `semver:` prefix and simply fails.
//
// Exercised through the real credentialed-clone path (`extractApplication` with a git credential
// session active), against a genuine local git repository, rather than unit-testing the resolution
// logic in isolation: the whole point is that a `semver:` committish now survives all the way through
// `packGitReferenceWithoutScripts` to a successful checkout.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { Application, extractApplication } = require('#src/components/Application');
const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// git may not be installed/in PATH in every test environment; resolved lazily so a missing git skips
// gracefully in before() rather than crashing the whole suite's loading.
let GIT_AVAILABLE = true;
try {
	execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
	GIT_AVAILABLE = false;
}

// A bare repo with tagged commits, each carrying a package.json `version` matching its tag, so a
// resolved checkout can be verified by reading the extracted manifest back out. `tags` pairs a tag
// name with the version it should carry — letting a case exercise a prefixed tag (`component-v3.0.0`)
// alongside the plain ones. A `v1.2.3` branch (pointing at different content than the `v1.2.3` tag)
// proves resolution checks out the tag, not a same-named branch.
async function createTaggedRepo(root, tags) {
	const work = path.join(root, 'work');
	const bare = path.join(root, 'semver-component.git');
	await fs.mkdir(work, { recursive: true });
	const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
	git('init', '--quiet', '--initial-branch=main');
	git('config', 'user.email', 'test@harperdb.io');
	git('config', 'user.name', 'Harper Test');
	git('config', 'commit.gpgsign', 'false');

	const writeVersion = async (version) => {
		await fs.writeFile(
			path.join(work, 'package.json'),
			JSON.stringify({ name: 'semver-component', version, description: 'private test component' }, null, 2)
		);
		git('add', '.');
		git('commit', '--quiet', '-m', `v${version}`);
	};

	for (const { tag, version } of tags) {
		await writeVersion(version);
		// Explicit -a -m avoids relying on the lightweight-tag default, which some git configs (e.g.
		// tag.gpgSign or an editor-invoking core.editor) turn into an annotated tag needing a message.
		git('tag', '-a', tag, '-m', tag);
	}

	// A branch sharing the resolved tag's name, pointing at different content: proves resolution
	// checks out `refs/tags/v1.2.3` rather than an ambiguous bare `v1.2.3` that git would resolve to
	// this branch first.
	git('branch', 'v1.2.3');
	git('checkout', '--quiet', 'v1.2.3');
	await writeVersion('branch-decoy');
	git('checkout', '--quiet', 'main');

	execFileSync('git', ['clone', '--quiet', '--bare', work, bare], { stdio: 'pipe' });
	return bare;
}

const STANDARD_TAGS = [
	{ tag: 'v1.0.0', version: '1.0.0' },
	{ tag: 'v1.2.3', version: '1.2.3' },
	{ tag: 'v2.0.0', version: '2.0.0' },
	// A common "prefixed tag" convention (e.g. a monorepo's per-package tags): npm's own git resolver
	// extracts the trailing version-shaped suffix from a tag like this one.
	{ tag: 'component-v3.0.0', version: '3.0.0' },
];

describe('semver-range committish resolution on a credentialed git-reference deploy', function () {
	this.timeout(60_000);

	let root;
	let packageIdentifier;

	before(async function () {
		if (process.platform === 'win32' || !GIT_AVAILABLE) return this.skip();
		// extractApplication packs into the components root, which the unit-test config points at but
		// does not create.
		await fs.mkdir(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), { recursive: true });
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-git-semver-'));
		const bareRepo = await createTaggedRepo(root, STANDARD_TAGS);
		// git+file:// takes the credentialed clone-and-checkout path exactly like git+https://; no
		// network/HTTP fixture is needed to exercise checkout resolution.
		packageIdentifier = `git+file://${bareRepo}`;
	});

	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	// A `credentials` entry with any host is enough to put the deploy on the credentialed path
	// (application.gitCredentialEnv truthy), which is what routes through packGitReferenceWithoutScripts
	// instead of a plain `npm pack`. The host need not match the git+file:// URL for this.
	function credentialedApplication(name, committish) {
		return new Application({
			name,
			packageIdentifier: `${packageIdentifier}#${committish}`,
			credentials: [{ host: 'example.com', token: 'unused-for-file-clone' }],
		});
	}

	it('resolves a semver:<range> committish to the highest satisfying tag before checkout', async () => {
		const application = credentialedApplication('git-semver-resolve', 'semver:^1.0.0');
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		// v1.2.3 is the highest tag satisfying ^1.0.0 (v2.0.0 is excluded by the caret range).
		assert.strictEqual(packageJSON.version, '1.2.3');
	});

	it("resolves an exact semver:<version> committish, matching #1799's own worked example", async () => {
		const application = credentialedApplication('git-semver-exact', 'semver:v2.0.0');
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		assert.strictEqual(packageJSON.version, '2.0.0');
	});

	it('leaves a non-semver committish untouched, checking it out literally', async () => {
		const application = credentialedApplication('git-semver-literal', 'v1.0.0');
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		assert.strictEqual(packageJSON.version, '1.0.0');
	});

	it('decodes a URL-encoded range (e.g. semver:%5E1.0.0), matching npm-package-arg', async () => {
		const application = credentialedApplication('git-semver-encoded', 'semver:%5E1.0.0');
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		// %5E decodes to `^`, so this is the same range (and result) as the `^1.0.0` case above.
		assert.strictEqual(packageJSON.version, '1.2.3');
	});

	it('resolves a range against the version embedded in a prefixed tag (component-v3.0.0)', async () => {
		const application = credentialedApplication('git-semver-prefixed-tag', 'semver:^3.0.0');
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		assert.strictEqual(packageJSON.version, '3.0.0');
	});

	it('checks out the resolved tag rather than a branch of the same name', async () => {
		const application = credentialedApplication('git-semver-tag-not-branch', 'semver:v1.2.3');
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		// The repo also has a branch named `v1.2.3` carrying `branch-decoy` content; an unqualified
		// `git checkout v1.2.3` resolves to that branch (confirmed empirically), not the tag.
		assert.strictEqual(packageJSON.version, '1.2.3');
	});

	it('throws a clear, diagnosable error when no tag satisfies the range', async () => {
		const application = credentialedApplication('git-semver-unsatisfiable', 'semver:^9.9.9');
		await application.startGitCredentialSession();
		try {
			await assert.rejects(
				() => extractApplication(application),
				(err) => {
					assert.match(err.message, /no tag satisfies range '\^9\.9\.9'/);
					assert.match(err.message, /v1\.0\.0/);
					assert.match(err.message, /v1\.2\.3/);
					assert.match(err.message, /v2\.0\.0/);
					return true;
				}
			);
		} finally {
			await application.cleanupGitCredentialSession();
		}
	});
});

describe('semver-committish resolution excludes tags unsafe to pass to a shell (#1797 review)', function () {
	this.timeout(60_000);

	let root;
	let marker;
	let packageIdentifier;

	before(async function () {
		if (process.platform === 'win32' || !GIT_AVAILABLE) return this.skip();
		await fs.mkdir(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), { recursive: true });
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-git-semver-injection-'));
		marker = path.join(root, 'pwned-marker');

		const work = path.join(root, 'work');
		const bare = path.join(root, 'semver-injection.git');
		await fs.mkdir(work, { recursive: true });
		const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
		git('init', '--quiet', '--initial-branch=main');
		git('config', 'user.email', 'test@harperdb.io');
		git('config', 'user.name', 'Harper Test');
		git('config', 'commit.gpgsign', 'false');
		await fs.writeFile(
			path.join(work, 'package.json'),
			JSON.stringify({ name: 'semver-injection', version: '1.0.0' }, null, 2)
		);
		git('add', '.');
		git('commit', '--quiet', '-m', 'v1.0.0');
		git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
		// A legal git tag name (git rejects a literal space in a ref name, so `${IFS}` stands in for
		// one — the classic space-free shell payload; confirmed this still expands to a real space
		// when a shell evaluates it) whose trailing suffix is a version-shaped string satisfying
		// `^9.0.0` — the only tag that would. `nonInteractiveSpawn` checks out its resolved committish
		// through a shell with no argument escaping, so if this tag name reached that spawn unfiltered,
		// `$(...)` would run as a command substitution before git ever saw the checkout target.
		git('tag', '-a', `$(touch\${IFS}${marker})v9.9.9`, '-m', 'malicious');

		execFileSync('git', ['clone', '--quiet', '--bare', work, bare], { stdio: 'pipe' });
		packageIdentifier = `git+file://${bare}`;
	});

	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it('does not execute a shell metacharacter embedded in a resolved tag name, and fails resolution instead', async () => {
		const application = new Application({
			name: 'git-semver-injection',
			packageIdentifier: `${packageIdentifier}#semver:^9.0.0`,
			credentials: [{ host: 'example.com', token: 'unused-for-file-clone' }],
		});
		await application.startGitCredentialSession();
		try {
			// Only the malicious tag's embedded 9.9.9 satisfies ^9.0.0; excluding it from resolution
			// means nothing satisfies the range, so this must fail closed rather than check it out.
			await assert.rejects(() => extractApplication(application), /no tag satisfies range '\^9\.0\.0'/);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		assert.ok(!existsSync(marker), 'the shell command substitution in the tag name must not have run');
	});
});
