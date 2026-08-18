'use strict';

// `harper deploy setup=true` grants the credential it seals to a component and labels it with a host.
// Both have to come out the way the *deploy* will resolve them — a component the deploy doesn't run
// as, or a host it wouldn't accept, seals a credential that can never be used. The derivations
// themselves are covered in unitTests/utility/componentNames.test.js; these cases cover how this flow
// resolves its inputs.
const assert = require('node:assert');
const path = require('node:path');
const { resolveComponentName, resolveGitHost, storeSealedSecret } = require('#src/bin/deploySetup');
const { directoryProjectName } = require('#src/utility/componentNames');
const cliOperationsModule = require('#src/bin/cliOperations');

describe('deploySetup', () => {
	describe('resolveComponentName', () => {
		it('canonicalizes an explicit project like deploy_component does', () => {
			assert.strictEqual(resolveComponentName({ project: 'web' }), 'web');
			// The server reduces `project` with path.parse().name, so a scoped name grants the bare one.
			assert.strictEqual(resolveComponentName({ project: '@scope/app' }), 'app');
		});

		it('falls back to the project a package spec implies', () => {
			assert.strictEqual(resolveComponentName({ package: 'github:owner/repo' }), 'repo');
			assert.strictEqual(resolveComponentName({ project: 'web', package: 'github:owner/repo' }), 'web');
		});

		it('leaves the default to the caller when the request names neither', () => {
			assert.strictEqual(resolveComponentName({}), undefined);
			// A non-string arg (`project=5` is JSON-parsed to a number) is not a name; prompt instead of
			// throwing inside path.parse.
			assert.strictEqual(resolveComponentName({ project: 5 }), undefined);
		});

		it('matches the directory name a bare `harper deploy` from the same cwd would send', () => {
			assert.strictEqual(directoryProjectName(), path.basename(process.cwd()));
		});

		// The seal is granted to the name setup resolves; `deploy by_ref=true` asks for a secret named
		// after the project IT resolves. If the two defaults disagree, resolveCredentials rejects the
		// stored secret as not granted — so they must agree even where a checkout directory and its
		// package.json name differ, which is exactly the case that used to diverge.
		it("agrees with prepareDeployByRef's project default, including when package.json disagrees", () => {
			const fs = require('fs-extra');
			const os = require('node:os');
			const { execFileSync } = require('node:child_process');
			const { prepareDeployByRef } = require('#src/bin/cliOperations');
			// A real repo, so prepareDeployByRef runs its own resolution rather than us substituting a
			// fallback — otherwise a regression back to the package.json name would still pass here.
			const root = path.join(os.tmpdir(), `harper-project-default-${process.pid}`);
			const dir = path.join(root, 'my-app-repo');
			fs.ensureDirSync(dir);
			fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/my-app' }));
			const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
			git('init', '-q');
			git('config', 'user.email', 'test@example.com');
			git('config', 'user.name', 'Test');
			git('config', 'commit.gpgsign', 'false');
			git('remote', 'add', 'origin', 'https://github.com/acme/my-app-repo.git');
			git('add', 'package.json');
			git('commit', '-qm', 'init');

			const cwd = process.cwd();
			const savedSha = process.env.GITHUB_SHA;
			try {
				delete process.env.GITHUB_SHA; // else the committish comes from the CI env, not this repo
				process.chdir(dir);
				const req = { operation: 'deploy_component', by_ref: true };
				prepareDeployByRef(req);
				assert.strictEqual(req.project, 'my-app-repo', 'by_ref must not prefer the package.json name');
				// The name setup would grant, for the same cwd, must be the name by_ref deploys under —
				// otherwise resolveCredentials rejects the sealed secret as not granted.
				assert.strictEqual(req.project, directoryProjectName());
				assert.strictEqual(req.project, resolveComponentName({ project: req.project }));
			} finally {
				process.chdir(cwd);
				if (savedSha === undefined) delete process.env.GITHUB_SHA;
				else process.env.GITHUB_SHA = savedSha;
				fs.removeSync(root);
			}
		});
	});

	describe('resolveGitHost', () => {
		it('canonicalizes to the bare host the credential entry carries', () => {
			assert.strictEqual(resolveGitHost('github.com'), 'github.com');
			assert.strictEqual(resolveGitHost('https://github.com/owner/repo'), 'github.com');
			assert.strictEqual(resolveGitHost('git@ghe.example.com'), 'ghe.example.com');
			assert.strictEqual(resolveGitHost('git.example.com:8443'), 'git.example.com:8443');
		});

		it('rejects what the deploy schema would reject rather than sealing an unusable entry', () => {
			for (const host of ['', '   ', 'git hub.com', 'a@b@c.com', undefined, 5]) {
				assert.throws(() => resolveGitHost(host), /Invalid git host/, String(host));
			}
		});
	});

	// `set_secret` REPLACES grants rather than merging, so sending `grants: [component]` on a rotation
	// would silently revoke a grant an operator added with `grant_secret` — invisible until the other
	// component's next deploy fails. Omitting the field keeps the stored list under the server's own
	// lock, and idempotent `grant_secret` adds this component. The protocol IS the fix, so it's what
	// these cases pin.
	describe('storeSealedSecret', () => {
		const SECRET = 'deploy.web.git.github.com';
		const ENVELOPE = 'enc:v1:abc';
		let originalCliOperations;
		let calls;

		beforeEach(() => {
			originalCliOperations = cliOperationsModule.cliOperations;
			calls = [];
		});

		afterEach(() => {
			cliOperationsModule.cliOperations = originalCliOperations;
		});

		function stub(grantResult) {
			cliOperationsModule.cliOperations = async (req) => {
				calls.push(req);
				return req.operation === 'grant_secret' ? grantResult : {};
			};
		}

		it('stores the envelope WITHOUT grants, so the server keeps any it already has', async () => {
			stub({ name: SECRET, grants: ['web'], changed: true });

			await storeSealedSecret({ target: 'example.com' }, SECRET, ENVELOPE, 'web');

			const setSecret = calls.find((c) => c.operation === 'set_secret');
			assert.ok(setSecret, 'set_secret was called');
			assert.strictEqual(setSecret.envelope, ENVELOPE);
			assert.strictEqual(
				'grants' in setSecret,
				false,
				'sending grants here would replace the stored list and revoke other components'
			);
		});

		// If the derived row already exists as a processEnv (global) secret, set_secret inherits that
		// tier — so without this the pasted token lands in the tier every component and child process
		// reads, and only then does grant_secret reject the row, reporting a failure it already
		// committed. Sending `grants` used to mask it (the server rejects processEnv+grants before
		// writing); omitting them for the merge removed that accident.
		it('pins the credential to the scoped tier, so it cannot be written as a global secret', async () => {
			stub({ grants: ['web'] });

			await storeSealedSecret({}, SECRET, ENVELOPE, 'web');

			const setSecret = calls.find((c) => c.operation === 'set_secret');
			assert.strictEqual(
				setSecret.processEnv,
				false,
				'inheriting a stored processEnv tier would publish this token globally'
			);
		});

		it('grants this component in a second, idempotent call after the row exists', async () => {
			stub({ name: SECRET, grants: ['web'], changed: true });

			await storeSealedSecret({}, SECRET, ENVELOPE, 'web');

			assert.deepStrictEqual(
				calls.map((c) => c.operation),
				['set_secret', 'grant_secret'],
				'grant_secret 404s if it runs before the row exists, so order matters'
			);
			const grant = calls[1];
			assert.strictEqual(grant.name, SECRET);
			assert.strictEqual(grant.component, 'web');
		});

		it("reports the server's full grant list, so a preserved grant is visible", async () => {
			stub({ name: SECRET, grants: ['other-app', 'web'], changed: true });
			assert.deepStrictEqual(await storeSealedSecret({}, SECRET, ENVELOPE, 'web'), ['other-app', 'web']);
		});

		it('falls back to this component for the summary when the response carries no grants', async () => {
			stub({});
			assert.deepStrictEqual(await storeSealedSecret({}, SECRET, ENVELOPE, 'web'), ['web']);
		});

		it('carries the caller transport context into both calls', async () => {
			stub({ grants: ['web'] });
			await storeSealedSecret(
				{ target: 'https://example.com:9925', rejectUnauthorized: false },
				SECRET,
				ENVELOPE,
				'web'
			);
			for (const call of calls) {
				assert.strictEqual(call.target, 'https://example.com:9925', call.operation);
				assert.strictEqual(call.rejectUnauthorized, false, call.operation);
			}
		});
	});
});
