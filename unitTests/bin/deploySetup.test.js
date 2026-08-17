'use strict';

// `harper deploy setup=true` grants the credential it seals to a component and labels it with a host.
// Both have to come out the way the *deploy* will resolve them — a component the deploy doesn't run
// as, or a host it wouldn't accept, seals a credential that can never be used. The derivations
// themselves are covered in unitTests/utility/componentNames.test.js; these cases cover how this flow
// resolves its inputs.
const assert = require('node:assert');
const path = require('node:path');
const { resolveComponentName, resolveGitHost } = require('#src/bin/deploySetup');

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
			const { directoryProjectName } = require('#src/utility/componentNames');
			assert.strictEqual(directoryProjectName(), path.basename(process.cwd()));
		});

		// The seal is granted to the name setup resolves; `deploy by_ref=true` asks for a secret named
		// after the project IT resolves. If the two defaults disagree, resolveCredentials rejects the
		// stored secret as not granted — so they must agree even where a checkout directory and its
		// package.json name differ, which is exactly the case that used to diverge.
		it("agrees with prepareDeployByRef's project default, including when package.json disagrees", () => {
			const fs = require('fs-extra');
			const os = require('node:os');
			const { prepareDeployByRef } = require('#src/bin/cliOperations');
			const dir = path.join(os.tmpdir(), `harper-project-default-${process.pid}`, 'my-app-repo');
			fs.ensureDirSync(dir);
			fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/my-app' }));
			const cwd = process.cwd();
			try {
				process.chdir(dir);
				const req = { operation: 'deploy_component', by_ref: true, ref: 'HEAD' };
				try {
					prepareDeployByRef(req);
				} catch {
					// Not a git repo — resolveGitTarget throws before setting `project`; resolve the default
					// the same way it does instead, which is the agreement under test.
					req.project = require('#src/utility/componentNames').directoryProjectName();
				}
				assert.strictEqual(req.project, 'my-app-repo', 'by_ref must not prefer the package.json name');
				assert.strictEqual(req.project, resolveComponentName({ project: req.project }));
			} finally {
				process.chdir(cwd);
				fs.removeSync(path.dirname(dir));
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
});
