'use strict';

// End-to-end proof that the git credential channel actually authenticates a real clone (#1792).
//
// The mechanism this feature rests on lives entirely outside our process — git decides whether to
// call a credential helper, npm decides which environment git inherits, and both have historically
// had version-specific quirks here. A test that stubs the helper would prove none of that. So this
// stands up a genuine private git remote (git-http-backend behind HTTP Basic auth) and deploys from
// it through the real extractApplication path, asserting that the clone succeeds only because the
// credential was served from memory.
//
// The remote speaks http rather than https purely so the test needs no certificate: git's credential
// machinery is identical for both, and TLS terminates below the layer this feature touches.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { Application, extractApplication } = require('#src/components/Application');
const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// git may not be installed/in PATH in every test environment; resolving this at module load time
// (before mocha's before() hook gets a chance to skip gracefully) would crash the whole suite's
// loading rather than just this file's tests, so fall back to undefined and let before() skip.
let GIT_HTTP_BACKEND;
try {
	GIT_HTTP_BACKEND = path.join(execFileSync('git', ['--exec-path']).toString().trim(), 'git-http-backend');
} catch {
	// git not installed/in PATH; before() skips when GIT_HTTP_BACKEND is unset.
}
const TOKEN = 'ghp_test_token_value';
const USERNAME = 'x-access-token';

// The one Authorization header the remote accepts: git's HTTPS basic-auth convention for a PAT.
function validAuthorization() {
	return 'Basic ' + Buffer.from(`${USERNAME}:${TOKEN}`).toString('base64');
}

// A CGI bridge to git's own smart-HTTP server, gated on Basic auth — the smallest thing that is a
// real private git remote rather than an imitation of one.
function startPrivateGitServer(projectRoot, onAuthorization) {
	const server = http.createServer((request, response) => {
		const authorization = request.headers.authorization ?? '';
		onAuthorization(authorization);
		if (authorization !== validAuthorization()) {
			response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="harper-test"' });
			response.end('unauthorized');
			return;
		}

		const url = new URL(request.url, 'http://localhost');
		const cgi = spawn(GIT_HTTP_BACKEND, {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: projectRoot,
				GIT_HTTP_EXPORT_ALL: '1',
				REQUEST_METHOD: request.method,
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.replace(/^\?/, ''),
				CONTENT_TYPE: request.headers['content-type'] ?? '',
				REMOTE_USER: USERNAME,
			},
		});
		request.pipe(cgi.stdin);

		// CGI replies with headers, a blank line, then the body — split it back out for the HTTP layer.
		let head = Buffer.alloc(0);
		let headersSent = false;
		cgi.stdout.on('data', (chunk) => {
			if (headersSent) return response.write(chunk);
			head = Buffer.concat([head, chunk]);
			const split = head.indexOf('\r\n\r\n');
			if (split === -1) return;
			const headers = {};
			for (const line of head.subarray(0, split).toString().split('\r\n')) {
				const separator = line.indexOf(':');
				if (separator > 0) headers[line.slice(0, separator)] = line.slice(separator + 1).trim();
			}
			headersSent = true;
			response.writeHead(Number(headers.Status?.split(' ')[0]) || 200, headers);
			response.write(head.subarray(split + 4));
		});
		cgi.stdout.on('end', () => response.end());
		cgi.on('error', () => response.destroy());
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
	});
}

// A bare repo with one commit, served as the "private" package. With `scripts`, the manifest also
// carries a prepare script — which npm runs, inside the clone, during `npm pack`.
async function createRepo(root, name, scripts) {
	const work = path.join(root, 'work-' + name);
	const bare = path.join(root, `${name}.git`);
	await fs.mkdir(work, { recursive: true });
	await fs.writeFile(
		path.join(work, 'package.json'),
		JSON.stringify({ name, version: '1.0.0', description: 'private test component', scripts }, null, 2)
	);
	await fs.writeFile(path.join(work, 'index.js'), '// private component source\n');
	// Stands in for a malicious prepare/postinstall script (the repo's own, or a transitive
	// dependency's): it records whatever credential wiring it inherited from the clone spawn.
	await fs.writeFile(
		path.join(work, 'steal.js'),
		`require('node:fs').writeFileSync(process.env.HARPER_TEST_STEAL_OUT, JSON.stringify({\n` +
			`  socket: process.env.HARPER_GIT_CREDENTIAL_SOCKET ?? null,\n` +
			`  askpass: process.env.GIT_ASKPASS ?? null,\n` +
			`}));\n`
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

describe('private git-reference deploy (real clone over authenticated git-over-http)', function () {
	// A real git clone through npm: slower than a unit test, but the only thing that proves the
	// credential reaches git.
	this.timeout(120_000);

	let root;
	let server;
	let packageIdentifier;
	let scriptedPackageIdentifier;
	let seenAuthorization;
	let stealOut;

	before(async function () {
		if (process.platform === 'win32' || !GIT_HTTP_BACKEND || !existsSync(GIT_HTTP_BACKEND)) return this.skip();
		// extractApplication packs into the components root, which the unit-test config points at but
		// does not create.
		await fs.mkdir(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), { recursive: true });
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-git-remote-'));
		await createRepo(root, 'private-component');
		await createRepo(root, 'scripted-component', { prepare: 'node ./steal.js' });
		stealOut = path.join(root, 'stolen.json');
		const started = await startPrivateGitServer(root, (authorization) => seenAuthorization.push(authorization));
		server = started.server;
		packageIdentifier = `git+http://127.0.0.1:${started.port}/private-component.git`;
		scriptedPackageIdentifier = `git+http://127.0.0.1:${started.port}/scripted-component.git`;
	});

	after(async () => {
		await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	beforeEach(async () => {
		seenAuthorization = [];
		await fs.rm(stealOut, { force: true });
	});

	// The credential entry's host: the remote's host:port, which is what git asks about.
	function gitHost() {
		return new URL(packageIdentifier.slice('git+'.length)).host;
	}

	it('fails to clone the private repo without a credential', async () => {
		const application = new Application({ name: 'git-clone-unauthenticated', packageIdentifier });
		await assert.rejects(
			() => extractApplication(application),
			/Failed to download package/,
			'a private repo must not be cloneable without a credential'
		);
		// npm points git at its own `GIT_ASKPASS=echo` when we supply none, so git does attempt an empty
		// credential — what matters is that no request could carry the token.
		assert.ok(
			seenAuthorization.every((header) => !header.includes(validAuthorization().slice('Basic '.length))),
			'the token cannot be presented without a credential session'
		);
	});

	it('clones the private repo with a token served from memory, and the token never lands on disk', async () => {
		const application = new Application({
			name: 'git-clone-authenticated',
			packageIdentifier,
			credentials: [{ host: gitHost(), token: TOKEN }],
		});

		// Exactly the sequence prepareApplication runs: bring the credential socket up, clone, tear it down.
		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		// The clone actually happened, and it authenticated.
		const packageJSON = JSON.parse(await fs.readFile(path.join(application.dirPath, 'package.json'), 'utf8'));
		assert.strictEqual(packageJSON.name, 'private-component');
		assert.ok(existsSync(path.join(application.dirPath, 'index.js')), 'repo contents extracted');
		assert.ok(
			seenAuthorization.some((header) => header === validAuthorization()),
			'git presented the token from the credential session'
		);

		// The token is not in the package identifier npm was given, so it cannot reach a lockfile, the
		// deployment row, or the operations log through it.
		assert.ok(!application.packageIdentifier.includes(TOKEN), 'token not embedded in the package URL');
		// Nor anywhere in the extracted component — the credential leaves no artifact behind.
		const files = await fs.readdir(application.dirPath, { recursive: true, withFileTypes: true });
		for (const file of files) {
			if (!file.isFile()) continue;
			const contents = await fs.readFile(path.join(file.parentPath ?? file.path, file.name), 'utf8').catch(() => '');
			assert.ok(!contents.includes(TOKEN), `token found on disk in ${file.name}`);
		}
	});

	it('does not persist the token to git-credentials even when a store helper is configured', async function () {
		// The sharpest leak path: git reports a *successful* authentication back to its credential
		// helper chain, so a machine with `credential.helper=store` (globally or URL-scoped) would write
		// the token to ~/.git-credentials — silently. The GIT_CONFIG_* helper reset must survive a real
		// clone, not just a synthetic `git credential approve`.
		const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-git-home-'));
		const gitConfig = path.join(home, '.gitconfig');
		const credentialsFile = path.join(home, '.git-credentials');
		const scopedCredentialsFile = path.join(home, '.git-credentials-scoped');
		const host = gitHost();
		await fs.writeFile(
			gitConfig,
			`[credential]\n\thelper = store --file ${credentialsFile}\n` +
				`[credential "http://${host}"]\n\thelper = store --file ${scopedCredentialsFile}\n`
		);

		const application = new Application({
			name: 'git-clone-store-helper',
			packageIdentifier,
			credentials: [{ host, token: TOKEN }],
		});

		const priorHome = process.env.HOME;
		const priorConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.HOME = home;
		process.env.GIT_CONFIG_GLOBAL = gitConfig;
		try {
			await application.startGitCredentialSession();
			try {
				await extractApplication(application);
			} finally {
				await application.cleanupGitCredentialSession();
			}
		} finally {
			if (priorHome === undefined) delete process.env.HOME;
			else process.env.HOME = priorHome;
			if (priorConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = priorConfigGlobal;
		}

		// The clone still authenticated (proving the helper chain was active)...
		assert.ok(
			seenAuthorization.some((header) => header === validAuthorization()),
			'the clone authenticated, so git did run its credential machinery'
		);
		// ...yet neither store file received the token.
		for (const file of [credentialsFile, scopedCredentialsFile]) {
			const persisted = await fs.readFile(file, 'utf8').catch(() => '');
			assert.ok(!persisted.includes(TOKEN), `token persisted to ${path.basename(file)}: ${persisted}`);
		}
		await fs.rm(home, { recursive: true, force: true });
	});

	// Packing a git reference is not just a download: npm clones the repo and runs its prepare/build
	// script — and its dependencies' install scripts — on this node, inside the clone spawn. Left
	// alone, any of that code could ask the socket for the token, which is precisely the reach the
	// credential must not have. Verified against real npm rather than asserted: this is npm's
	// behavior, not ours, and it is the whole reason the clone runs with scripts disabled.
	it('does not run the repository prepare script during a credentialed clone, so nothing can reach the socket', async () => {
		const application = new Application({
			name: 'git-clone-scripted',
			packageIdentifier: scriptedPackageIdentifier,
			credentials: [{ host: gitHost(), token: TOKEN }],
		});

		await application.startGitCredentialSession();
		try {
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}

		assert.ok(!existsSync(stealOut), 'the prepare script must not run while the credential is reachable');
	});

	it('runs the prepare script — with the credential in reach — only when the deploy opts into scripts', async () => {
		// install_allow_scripts is the operator explicitly asking for this repository's code to run on
		// the node. That is the one case where the credential is exposed to it, and it is logged.
		const application = new Application({
			name: 'git-clone-scripted-allowed',
			packageIdentifier: scriptedPackageIdentifier,
			install: { allowInstallScripts: true },
			credentials: [{ host: gitHost(), token: TOKEN }],
		});

		process.env.HARPER_TEST_STEAL_OUT = stealOut;
		try {
			await application.startGitCredentialSession();
			try {
				await extractApplication(application);
			} finally {
				await application.cleanupGitCredentialSession();
			}
		} finally {
			delete process.env.HARPER_TEST_STEAL_OUT;
		}

		assert.ok(existsSync(stealOut), 'the prepare script runs when scripts are allowed');
		const seen = JSON.parse(await fs.readFile(stealOut, 'utf8'));
		assert.ok(seen.socket, 'documents the exposure this opt-in accepts: the script can reach the socket');
	});

	it('stops authenticating once the session is closed', async () => {
		// The credential is bound to the clone, not to the deploy: anything that runs after extraction
		// (install scripts included) finds the socket gone.
		const application = new Application({
			name: 'git-clone-after-close',
			packageIdentifier,
			credentials: [{ host: gitHost(), token: TOKEN }],
		});
		await application.startGitCredentialSession();
		await application.cleanupGitCredentialSession();

		await assert.rejects(() => extractApplication(application), /Failed to download package/);
	});
});
