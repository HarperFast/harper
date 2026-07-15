'use strict';

// Regression for #1818: `npm pack` on a git-reference deploy isn't just a download — npm clones
// the repo and, if its manifest has a prepare/build/install script, runs `npm install` inside the
// clone and then that script, so the repository's own code runs on this node during the pack step
// alone, before the later `npm install` even starts. `install_allow_scripts` is the operator-facing
// switch for whether a deployed component's scripts may run on this node, so it has to gate this
// step too — previously it only reached the later `npm install`, and only when a git credential
// happened to be in play (harper#1799). This proves the gate now applies to a plain,
// uncredentialed git-reference deploy, against a real local git repo and real npm pack rather than
// asserting on the constructed spawn args.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { Application, extractApplication, parseGitReference } = require('#src/components/Application');
const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// git may not be installed/in PATH in every test environment; resolve this before mocha's before()
// hook so we can skip gracefully instead of crashing the whole suite's loading.
let GIT_AVAILABLE = true;
try {
	execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
	GIT_AVAILABLE = false;
}

// A bare repo with one commit, whose manifest carries a prepare script — which npm runs, inside
// the clone, during `npm pack`.
async function createRepo(root, name) {
	const work = path.join(root, `work-${name}`);
	const bare = path.join(root, `${name}.git`);
	await fs.mkdir(work, { recursive: true });
	await fs.writeFile(
		path.join(work, 'package.json'),
		JSON.stringify({ name, version: '1.0.0', scripts: { prepare: 'node ./mark.js' } }, null, 2)
	);
	await fs.writeFile(
		path.join(work, 'mark.js'),
		`require('node:fs').writeFileSync(process.env.HARPER_TEST_PACK_MARKER, 'ran');\n`
	);
	const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
	git('init', '--quiet', '--initial-branch=main');
	git('config', 'user.email', 'test@harperdb.io');
	git('config', 'user.name', 'Harper Test');
	git('config', 'commit.gpgsign', 'false');
	git('add', '.');
	git('commit', '--quiet', '-m', 'initial');
	execFileSync('git', ['clone', '--quiet', '--bare', work, bare], { stdio: 'pipe' });
	return bare;
}

describe('npm pack --ignore-scripts for git-reference deploys (#1818)', function () {
	this.timeout(60_000);

	let root;
	let packageIdentifier;
	let marker;

	before(async function () {
		if (process.platform === 'win32' || !GIT_AVAILABLE) return this.skip();
		// extractApplication packs into the components root, which the unit-test config points at
		// but does not create.
		await fs.mkdir(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), { recursive: true });
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-git-pack-'));
		const bare = await createRepo(root, 'pack-scripted');
		packageIdentifier = `git+file://${bare}`;
	});

	after(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		marker = path.join(root, `marker-${process.hrtime.bigint()}`);
	});

	afterEach(async () => {
		delete process.env.HARPER_TEST_PACK_MARKER;
		await fs.rm(marker, { force: true });
	});

	it('does not run the prepare script during npm pack when install_allow_scripts is unset, without a git credential involved', async () => {
		const application = new Application({ name: 'pack-scripted-default', packageIdentifier });
		process.env.HARPER_TEST_PACK_MARKER = marker;

		await extractApplication(application);

		assert.ok(!existsSync(marker), 'prepare script must not run during npm pack by default');
	});

	it('runs the prepare script during npm pack when install_allow_scripts is explicitly true', async () => {
		const application = new Application({
			name: 'pack-scripted-allowed',
			packageIdentifier,
			install: { allowInstallScripts: true },
		});
		process.env.HARPER_TEST_PACK_MARKER = marker;

		await extractApplication(application);

		assert.ok(existsSync(marker), 'prepare script should run once scripts are explicitly allowed');
	});
});

// Regression for the #1819 review comment: a bare `https://`/`http://` git-host URL (no `git+`
// prefix) is resolved by npm exactly like `git+https://` — hosted-git-info lists plain http/https
// in every known host's `protocols` array — so it must be recognized as a git reference too,
// instead of silently falling through to the unreliable `npm pack --ignore-scripts` path.
describe('bare https/http git-host URL recognition (#1819)', function () {
	it('parses a bare https:// URL to a known git host into a clone URL', function () {
		const ref = parseGitReference('https://github.com/owner/repo.git');
		assert.ok(ref);
		assert.strictEqual(ref.cloneUrl, 'https://github.com/owner/repo.git');
		assert.strictEqual(ref.committish, undefined);
	});

	it('parses a bare http:// URL with a committish', function () {
		const ref = parseGitReference('http://gitlab.com/owner/repo#deadbeef');
		assert.ok(ref);
		assert.strictEqual(ref.cloneUrl, 'http://gitlab.com/owner/repo');
		assert.strictEqual(ref.committish, 'deadbeef');
	});

	it('does not treat a bare URL to an unrecognized host as a git reference', function () {
		assert.strictEqual(parseGitReference('https://example.com/owner/repo.git'), null);
	});

	// `#semver:` was originally unimplemented here too (as this test's history shows — see blame),
	// but harper#1797's follow-up added semver-range committish resolution
	// (packGitReferenceWithoutScripts's resolveCommittish), so a `#semver:` committish is now a
	// safely-handleable form regardless of URL shape. `#path:` (npm's git-url monorepo-subdirectory
	// extension) remains genuinely unimplemented by either feature, so it's used here instead to
	// exercise the same "recognized as git, but not safely handleable" guard.
	it('refuses a bare-URL git reference in a form it cannot safely handle, rather than falling through to npm pack --ignore-scripts', async function () {
		if (process.platform === 'win32' || !GIT_AVAILABLE) return this.skip();
		const application = new Application({
			name: 'pack-bare-url-unsupported',
			packageIdentifier: 'https://github.com/some-owner/some-repo#path:packages/foo',
		});

		await assert.rejects(extractApplication(application), /install scripts disallowed/);
	});
});
