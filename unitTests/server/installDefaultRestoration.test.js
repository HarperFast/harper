'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

describe('install default restoration on a fresh boot', function () {
	it('keeps omitted roots absent after releasing scalar, null, array and empty env values', function () {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-omitted-'));
		try {
			const output = execFileSync(
				process.execPath,
				[
					...process.execArgv.filter((arg) => arg.startsWith('--conditions=')),
					path.join(__dirname, 'fixtures/installDefaultRestoration.cjs'),
					'omitted',
				],
				{
					cwd: path.resolve(__dirname, '../..'),
					env: { ...process.env, ROOTPATH: root },
					encoding: 'utf8',
					timeout: 30000,
				}
			);
			assert.match(output, /install-default-restoration-ok/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	for (const envVar of ['HARPER_DEFAULT_CONFIG', 'HARPER_CONFIG', 'HARPER_SET_CONFIG']) {
		for (const introducedBy of ['arg', 'env']) {
			it(`restores required defaults after removing ${envVar} from an ${introducedBy}-introduced section`, function () {
				const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-restoration-'));
				try {
					const root = path.join(temp, 'root');
					fs.mkdirSync(root);
					const template = path.join(temp, 'template.yaml');
					fs.writeFileSync(
						template,
						YAML.stringify({
							rootPath: root,
							http: { port: null, securePort: null },
							operationsApi: { network: { port: null, securePort: null } },
							analytics: { aggregatePeriod: -1 },
						})
					);
					const childEnv = {
						...process.env,
						ROOTPATH: root,
						HDB_CONFIG: template,
						HOME: path.join(temp, 'home'),
						USERPROFILE: path.join(temp, 'home'),
						HDB_ADMIN_USERNAME: 'admin',
						HDB_ADMIN_PASSWORD: 'test-install-default-restoration',
						DEFAULTS_MODE: 'prod',
						HARPER_DEFAULT_CONFIG: '',
						HARPER_CONFIG: '',
						HARPER_SET_CONFIG: '',
						AUTHENTICATION_AUTHORIZELOCAL: introducedBy === 'arg' ? 'true' : '',
						[envVar]: JSON.stringify({
							authentication: { cacheTTL: 60000, ...(introducedBy === 'env' && { authorizeLocal: true }) },
							...(introducedBy === 'env' && {
								mqtt: { requireAuthentication: false },
								applications: { allowedSpawnCommands: { $union: ['bun'] } },
							}),
						}),
					};
					if (introducedBy !== 'arg') delete childEnv.AUTHENTICATION_AUTHORIZELOCAL;
					const run = (phase) => {
						const output = execFileSync(
							process.execPath,
							[
								...process.execArgv.filter((arg) => arg.startsWith('--conditions=')),
								path.join(__dirname, 'fixtures/installDefaultRestoration.cjs'),
								phase,
								envVar,
								introducedBy,
							],
							{ cwd: path.resolve(__dirname, '../..'), env: childEnv, encoding: 'utf8', timeout: 120000, stdio: 'pipe' }
						);
						assert.match(output, /install-default-restoration-ok/);
					};
					run('install');
					childEnv.HDB_CONFIG = path.join(root, 'harper-config.yaml');
					childEnv[envVar] = '';
					delete childEnv.AUTHENTICATION_AUTHORIZELOCAL;
					run('boot');
					run('boot');
				} finally {
					fs.rmSync(temp, { recursive: true, force: true });
				}
			});
		}
	}
});
