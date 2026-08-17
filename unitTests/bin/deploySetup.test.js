'use strict';

// `harper deploy setup=true` grants the credential it seals to a component and labels it with a host.
// Both have to come out the way the *deploy* will resolve them — a component the deploy doesn't run
// as, or a host it wouldn't accept, seals a credential that can never be used. The derivations
// themselves are covered in unitTests/utility/componentNames.test.js; these cases cover how this flow
// resolves its inputs.
const assert = require('node:assert');
const path = require('node:path');
const { resolveComponentName, resolveGitHost, resolveGrants } = require('#src/bin/deploySetup');
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

	// `set_secret` replaces grants rather than merging, so sending only this component on a rotation
	// would silently revoke a grant an operator added with `grant_secret` — invisible until the other
	// component's next deploy fails. Both branches are pinned: the union, and the lookup-failure
	// fallback that still replaces (which is why it warns).
	describe('resolveGrants', () => {
		const SECRET = 'deploy.web.git.github.com';
		let originalCliOperations;
		let originalLog;
		let logged;

		beforeEach(() => {
			originalCliOperations = cliOperationsModule.cliOperations;
			originalLog = console.log;
			logged = [];
			console.log = (...args) => logged.push(args.join(' '));
		});

		afterEach(() => {
			cliOperationsModule.cliOperations = originalCliOperations;
			console.log = originalLog;
		});

		it("unions this component with the row's existing grants, so a rotation keeps them", async () => {
			cliOperationsModule.cliOperations = async (req) => {
				assert.strictEqual(req.operation, 'list_secrets');
				return {
					secrets: [
						{ name: SECRET, grants: ['other-app'] },
						{ name: 'unrelated', grants: ['nope'] },
					],
				};
			};

			const grants = await resolveGrants({ target: 'example.com' }, SECRET, 'web');

			assert.deepStrictEqual([...grants].sort(), ['other-app', 'web']);
			assert.ok(
				logged.some((line) => line.includes('other-app')),
				`should report the grant it preserved, got: ${JSON.stringify(logged)}`
			);
		});

		it('does not duplicate the component when the row already grants it', async () => {
			cliOperationsModule.cliOperations = async () => ({ secrets: [{ name: SECRET, grants: ['web'] }] });
			assert.deepStrictEqual(await resolveGrants({}, SECRET, 'web'), ['web']);
		});

		it('sends only this component when the row does not exist yet', async () => {
			cliOperationsModule.cliOperations = async () => ({ secrets: [] });
			assert.deepStrictEqual(await resolveGrants({}, SECRET, 'web'), ['web']);
		});

		it('falls back to this component alone on a lookup failure, and says so', async () => {
			cliOperationsModule.cliOperations = async () => {
				throw new Error('list_secrets is not available');
			};

			const grants = await resolveGrants({}, SECRET, 'web');

			assert.deepStrictEqual(grants, ['web']);
			assert.ok(
				logged.some((line) => line.includes(SECRET) && /couldn't read existing grants/i.test(line)),
				`the replace is only acceptable if it's visible, got: ${JSON.stringify(logged)}`
			);
		});
	});
});
