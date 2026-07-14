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

const GIT_HTTP_BACKEND = path.join(execFileSync('git', ['--exec-path']).toString().trim(), 'git-http-backend');
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

// A bare repo with one commit, served as the "private" package.
async function createRepo(root, name) {
	const work = path.join(root, 'work');
	const bare = path.join(root, `${name}.git`);
	await fs.mkdir(work, { recursive: true });
	await fs.writeFile(
		path.join(work, 'package.json'),
		JSON.stringify({ name, version: '1.0.0', description: 'private test component' }, null, 2)
	);
	await fs.writeFile(path.join(work, 'index.js'), '// private component source\n');
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
	let seenAuthorization;

	before(async function () {
		if (process.platform === 'win32' || !existsSync(GIT_HTTP_BACKEND)) return this.skip();
		// extractApplication packs into the components root, which the unit-test config points at but
		// does not create.
		await fs.mkdir(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), { recursive: true });
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-git-remote-'));
		await createRepo(root, 'private-component');
		const started = await startPrivateGitServer(root, (authorization) => seenAuthorization.push(authorization));
		server = started.server;
		packageIdentifier = `git+http://127.0.0.1:${started.port}/private-component.git`;
	});

	after(async () => {
		await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		seenAuthorization = [];
	});

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
			credentials: [{ host: `127.0.0.1:${new URL(packageIdentifier.slice(4)).port}`, token: TOKEN }],
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

	it('stops authenticating once the session is closed', async () => {
		// The credential is bound to the clone, not to the deploy: anything that runs after extraction
		// (install scripts included) finds the socket gone.
		const application = new Application({
			name: 'git-clone-after-close',
			packageIdentifier,
			credentials: [{ host: `127.0.0.1:${new URL(packageIdentifier.slice(4)).port}`, token: TOKEN }],
		});
		await application.startGitCredentialSession();
		await application.cleanupGitCredentialSession();

		await assert.rejects(() => extractApplication(application), /Failed to download package/);
	});
});
