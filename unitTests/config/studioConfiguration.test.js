'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } = require('node:fs');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const { readFile } = require('node:fs/promises');
const { setConfiguration, getConfigFilePath, initConfig } = require('#src/config/configUtils');
const { createStudioConfigurationReader, getStudioConfiguration } = require('#src/config/studioConfiguration');
const { preserveRootConfig, readRootConfig, setRootConfigEntry } = require('../rootConfigFixture.js');

const SECRET = 'studio-sentinel-credential-7f3a';

function captureWarnings() {
	const warnings = [];
	return { warnings, logger: { warn: (message) => warnings.push(message) } };
}

describe('get_studio_configuration', () => {
	let componentsRoot;
	let originalComponentsRoot;
	let originalDevApplication;

	function writeComponent(name, config, fileName = 'config.yaml') {
		const directory = path.join(componentsRoot, name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, fileName), config);
		return directory;
	}

	const redirectsConfig = `
rest: true
secretPlugin:
  apiKey: ${SECRET}
studio:
  pages:
    - id: redirects
      name: Redirects
      icon: signpost
      placement: tab
      description: HTTP redirects served before your app runs.
      access:
        role: super_user
        tables: [{ database: redirects, table: Rule, actions: [read] }]
      content: { kind: sections, sections: [{ kind: table, nested: { deep: [1, 2] } }] }
      extraField: ${SECRET}
    - id: rules
      name: Rules
      placement: config
`;

	before(() => {
		originalComponentsRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		originalDevApplication = process.env.RUN_HDB_APP;
		delete process.env.RUN_HDB_APP;
	});

	beforeEach(() => {
		componentsRoot = mkdtempSync(path.join(tmpdir(), 'harper-studio-config-'));
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, componentsRoot);
	});

	afterEach(() => {
		rmSync(componentsRoot, { recursive: true, force: true });
		delete process.env.RUN_HDB_APP;
	});

	after(() => {
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, originalComponentsRoot);
		if (originalDevApplication !== undefined) process.env.RUN_HDB_APP = originalDevApplication;
	});

	preserveRootConfig();

	describe('root settings', () => {
		it('returns only navigation and landing, and omits them when unset', async () => {
			setRootConfigEntry('studio', null);
			const { warnings, logger } = captureWarnings();
			assert.deepStrictEqual(await createStudioConfigurationReader(logger)(), { pages: [] });

			setRootConfigEntry('studio', {
				navigation: { applications: 'hidden', logs: 'tucked', databases: 'visible' },
				landing: 'harper-redirects.redirects',
				apiKey: SECRET,
			});
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(configuration, {
				navigation: { applications: 'hidden', logs: 'tucked', databases: 'visible' },
				landing: 'harper-redirects.redirects',
				pages: [],
			});
			assert.deepStrictEqual(warnings, []);
		});

		it('drops invalid entries with one warning that never repeats the value found', async () => {
			setRootConfigEntry('studio', {
				navigation: {
					apis: 'hidden',
					logs: 'gone',
					Bad_Key: 'hidden',
					[`${SECRET}_key`]: null,
					status: null,
					cluster: 'tucked',
					config: [SECRET],
				},
				landing: { apiKey: SECRET },
			});
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(configuration, { navigation: { apis: 'hidden', cluster: 'tucked' }, pages: [] });
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /root config/);
			assert.match(warnings[0], /studio\.navigation\.logs must be visible, tucked or hidden/);
			assert.match(warnings[0], /studio\.navigation\.config must be visible, tucked or hidden/);
			assert.strictEqual(
				warnings[0].match(/studio\.navigation has a key that is neither a tab key nor <component>\.<pageId>/g).length,
				2
			);
			assert.match(warnings[0], /studio\.landing must be a tab key or <component>\.<pageId>/);
			assert.ok(!warnings[0].includes(SECRET) && !warnings[0].includes('gone'));
		});

		it('drops a navigation value a YAML alias makes refer to itself, without failing the call', async () => {
			writeFileSync(
				getConfigFilePath(),
				`${readFileSync(getConfigFilePath(), 'utf8')}\nstudio:\n  navigation:\n    logs: &loop [*loop]\n    apis: hidden\n`
			);
			const { warnings, logger } = captureWarnings();
			assert.deepStrictEqual((await createStudioConfigurationReader(logger)()).navigation, { apis: 'hidden' });
			assert.strictEqual(warnings.length, 1);
		});

		for (const studio of ['hidden', ['applications'], true]) {
			it(`ignores a root studio block of ${JSON.stringify(studio)} with a warning`, async () => {
				setRootConfigEntry('studio', studio);
				const { warnings, logger } = captureWarnings();
				assert.deepStrictEqual(await createStudioConfigurationReader(logger)(), { pages: [] });
				assert.strictEqual(warnings.length, 1);
				assert.match(warnings[0], /studio must be a map/);
			});
		}

		it('still returns component pages when the root config is unreadable', async () => {
			writeComponent('harper-redirects', redirectsConfig);
			const configPath = getConfigFilePath();
			writeFileSync(configPath, `rootPath: x\nstudio: [unclosed\napiKey: ${SECRET}\n`);
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(
				configuration.pages.map((page) => page.id),
				['redirects', 'rules']
			);
			assert.strictEqual(configuration.navigation, undefined);
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /the root config could not be read/);
			assert.ok(!warnings[0].includes(SECRET), 'the parse warning must not quote the config source');
		});
	});

	describe('component pages', () => {
		it('returns allowlisted page fields, with access and content passed through unchanged', async () => {
			writeComponent('harper-redirects', redirectsConfig);
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(configuration.pages, [
				{
					component: 'harper-redirects',
					id: 'redirects',
					name: 'Redirects',
					icon: 'signpost',
					placement: 'tab',
					description: 'HTTP redirects served before your app runs.',
					access: { role: 'super_user', tables: [{ database: 'redirects', table: 'Rule', actions: ['read'] }] },
					content: { kind: 'sections', sections: [{ kind: 'table', nested: { deep: [1, 2] } }] },
				},
				{ component: 'harper-redirects', id: 'rules', name: 'Rules', placement: 'config' },
			]);
			assert.ok(!JSON.stringify(configuration).includes(SECRET));
			assert.deepStrictEqual(warnings, []);
		});

		it('drops each malformed page with a warning and keeps the rest', async () => {
			writeComponent(
				'mixed',
				`
studio:
  pages:
    - { id: good, name: Good, placement: tab }
    - { id: Bad_Id, name: Bad, placement: tab }
    - { id: no-name, name: '  ', placement: tab }
    - { id: nowhere, name: Nowhere, placement: sidebar }
    - { id: good, name: Again, placement: config }
    - just-a-string
    - { name: Missing id, placement: tab }
`
			);
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(configuration.pages, [{ component: 'mixed', id: 'good', name: 'Good', placement: 'tab' }]);
			assert.strictEqual(warnings.length, 1);
			for (const problem of [
				/studio\.pages\[1\]\.id must be a string matching/,
				/studio\.pages\[2\] \('no-name'\) must have a non-empty name/,
				/studio\.pages\[3\] \('nowhere'\) placement must be tab or config/,
				/studio\.pages\[4\]\.id 'good' repeats/,
				/studio\.pages\[5\] must be a map/,
				/studio\.pages\[6\]\.id must be a string matching/,
			])
				assert.match(warnings[0], problem);
			assert.match(warnings[0], /component 'mixed'/);
			assert.ok(!warnings[0].includes('Bad_Id') && !warnings[0].includes('sidebar'));
		});

		it('leaves out an icon or description that is not a string, and keeps the page', async () => {
			writeComponent(
				'typed',
				`studio:\n  pages:\n    - { id: page, name: Page, placement: tab, icon: { svg: ${SECRET} }, description: 5 }\n    - { id: empty, name: Empty, placement: tab, icon: }\n`
			);
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(configuration.pages, [
				{ component: 'typed', id: 'page', name: 'Page', placement: 'tab' },
				{ component: 'typed', id: 'empty', name: 'Empty', placement: 'tab' },
			]);
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /\('page'\) icon must be a string; it is left out/);
			assert.match(warnings[0], /\('page'\) description must be a string; it is left out/);
			assert.ok(!warnings[0].includes(SECRET));
		});

		it('drops a page whose content a YAML alias makes refer to itself, and keeps the rest', async () => {
			writeComponent(
				'looped',
				'studio:\n  pages:\n    - { id: loop, name: Loop, placement: tab, content: &loop { self: *loop } }\n    - { id: fine, name: Fine, placement: tab }\n'
			);
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(
				configuration.pages.map((page) => page.id),
				['fine']
			);
			assert.doesNotThrow(() => JSON.stringify(configuration));
			assert.match(warnings[0], /\('loop'\) holds a value that cannot be returned as JSON/);
		});

		it('ignores a pages value that is not a list, and a studio value that is not a map', async () => {
			writeComponent('not-a-list', 'studio:\n  pages: { id: x }\n');
			writeComponent('not-a-map', 'studio: yes\n');
			writeComponent('no-pages', 'studio: {}\n');
			const { warnings, logger } = captureWarnings();
			assert.deepStrictEqual((await createStudioConfigurationReader(logger)()).pages, []);
			assert.strictEqual(warnings.length, 2);
			assert.match(
				warnings.find((warning) => warning.includes("'not-a-list'")),
				/studio\.pages must be a list/
			);
			assert.match(
				warnings.find((warning) => warning.includes("'not-a-map'")),
				/studio must be a map/
			);
		});

		it('isolates an unparseable component config without quoting its source', async () => {
			writeComponent('broken', `studio:\n  pages: [\napiKey: ${SECRET}\n`);
			writeComponent('harper-redirects', redirectsConfig);
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(
				configuration.pages.map((page) => `${page.component}.${page.id}`),
				['harper-redirects.redirects', 'harper-redirects.rules']
			);
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /component 'broken': its config could not be read/);
			assert.ok(!warnings[0].includes(SECRET));
		});

		it('reads the config file the loader would, and stops at the first one present', async () => {
			const studioPage = 'studio:\n  pages: [{ id: page, name: Page, placement: tab }]\n';
			writeComponent('from-harper-config', studioPage, 'harper-config.yaml');
			writeComponent('from-harperdb-config', studioPage, 'harperdb-config.yaml');
			const shadowed = writeComponent('shadowed', studioPage);
			writeFileSync(path.join(shadowed, 'harperdb-config.yaml'), 'rest: true\n');
			const invalidFirst = writeComponent('invalid-first', studioPage);
			writeFileSync(path.join(invalidFirst, 'harper-config.yaml'), 'studio: [unclosed\n');
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(
				configuration.pages.map((page) => page.component),
				['from-harper-config', 'from-harperdb-config']
			);
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0], /component 'invalid-first'/);
		});

		it("skips Harper's dot-prefixed bookkeeping and plain files, and orders by component", async () => {
			const studioPage = 'studio:\n  pages: [{ id: page, name: Page, placement: tab }]\n';
			writeComponent('zeta', studioPage);
			writeComponent('alpha', studioPage);
			writeComponent(path.join('.deploy-staging', 'some-deployment', 'staged'), studioPage);
			writeComponent('.deploy-staging', studioPage);
			writeFileSync(path.join(componentsRoot, 'stray.yaml'), studioPage);
			symlinkSync(path.join(componentsRoot, 'stray.yaml'), path.join(componentsRoot, 'linked-file'));
			const { warnings, logger } = captureWarnings();
			const configuration = await createStudioConfigurationReader(logger)();
			assert.deepStrictEqual(
				configuration.pages.map((page) => page.component),
				['alpha', 'zeta']
			);
			assert.deepStrictEqual(warnings, [], 'a link to a file is a component with no config, as the loader sees it');
		});

		it('reflects a component appearing and disappearing on the next call', async () => {
			const read = createStudioConfigurationReader(captureWarnings().logger);
			assert.deepStrictEqual((await read()).pages, []);
			const directory = writeComponent('harper-redirects', redirectsConfig);
			assert.strictEqual((await read()).pages.length, 2);
			rmSync(directory, { recursive: true });
			assert.deepStrictEqual((await read()).pages, []);
		});

		it('still returns the `harper dev` application when the components root cannot be listed', async () => {
			const notADirectory = path.join(componentsRoot, 'a-file');
			writeFileSync(notADirectory, '');
			env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, notADirectory);
			const outside = mkdtempSync(path.join(tmpdir(), 'harper-studio-dev-'));
			try {
				writeFileSync(
					path.join(outside, 'config.yaml'),
					'studio:\n  pages: [{ id: page, name: Dev, placement: tab }]\n'
				);
				process.env.RUN_HDB_APP = outside;
				const { warnings, logger } = captureWarnings();
				const configuration = await createStudioConfigurationReader(logger)();
				assert.deepStrictEqual(
					configuration.pages.map((page) => page.name),
					['Dev']
				);
				assert.match(warnings[0], /the components root could not be listed/);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});

		it('returns no pages when the components root does not exist', async () => {
			env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, path.join(componentsRoot, 'missing'));
			const { warnings, logger } = captureWarnings();
			assert.deepStrictEqual(await createStudioConfigurationReader(logger)(), { pages: [] });
			assert.deepStrictEqual(warnings, []);
		});

		it('includes the `harper dev` application under its directory name, once', async () => {
			const studioPage = (name) => `studio:\n  pages: [{ id: page, name: ${name}, placement: tab }]\n`;
			const outside = mkdtempSync(path.join(tmpdir(), 'harper-studio-dev-'));
			try {
				const devApplication = path.join(outside, 'my-dev-app');
				mkdirSync(devApplication);
				writeFileSync(path.join(devApplication, 'config.yaml'), studioPage('Dev'));
				process.env.RUN_HDB_APP = devApplication;
				assert.deepStrictEqual(
					(await getStudioConfiguration()).pages.map((page) => `${page.component}:${page.name}`),
					['my-dev-app:Dev']
				);

				process.env.RUN_HDB_APP = writeComponent('installed-app', studioPage('Installed'));
				assert.deepStrictEqual(
					(await getStudioConfiguration()).pages.map((page) => `${page.component}:${page.name}`),
					['installed-app:Installed']
				);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	describe('warnings', () => {
		it('logs a source when its problems change, not on every call', async () => {
			const { warnings, logger } = captureWarnings();
			const read = createStudioConfigurationReader(logger);
			const broken = 'studio:\n  pages: [{ id: Bad, name: Bad, placement: tab }]\n';
			writeComponent('flaky', broken);
			await read();
			await read();
			assert.strictEqual(warnings.length, 1);

			writeComponent('flaky', 'studio:\n  pages: [{ id: bad, name: Bad, placement: nowhere }]\n');
			await read();
			assert.strictEqual(warnings.length, 2);
			assert.match(warnings[1], /placement must be tab or config/);

			writeComponent('flaky', 'studio:\n  pages: [{ id: fixed, name: Fixed, placement: tab }]\n');
			await read();
			assert.strictEqual(warnings.length, 2);

			writeComponent('flaky', broken);
			await read();
			assert.strictEqual(warnings.length, 3, 'a source broken again after a fix is logged again');

			rmSync(path.join(componentsRoot, 'flaky'), { recursive: true });
			await read();
			writeComponent('flaky', broken);
			await read();
			assert.strictEqual(warnings.length, 4, 'a source removed and re-added is logged again');
		});
	});

	describe('concurrent calls', () => {
		it('give a call that arrives during a scan the state as of its arrival, from one shared follow-up scan', async () => {
			const { warnings, logger } = captureWarnings();
			const read = createStudioConfigurationReader(logger);
			writeComponent('flaky', 'studio:\n  pages: [{ id: Bad, name: Bad, placement: tab }]\n');
			setRootConfigEntry('studio', { landing: 'before' });
			const inFlight = read();
			setRootConfigEntry('studio', { landing: 'after' });
			const followUps = [read(), read(), read()];
			assert.strictEqual(followUps[0], followUps[1], 'callers arriving during one scan share the next');
			assert.strictEqual(followUps[1], followUps[2]);
			assert.strictEqual((await inFlight).landing, 'before');
			assert.strictEqual((await followUps[0]).landing, 'after');
			assert.strictEqual(warnings.length, 1);
		});

		it('keep at most eight component configs open at once', async () => {
			for (let index = 0; index < 60; index++)
				writeComponent(
					`component-${String(index).padStart(2, '0')}`,
					`studio:\n  pages: [{ id: p, name: P${index}, placement: tab }]\n`
				);
			let open = 0;
			let peak = 0;
			const countingReadFile = async (filePath, encoding) => {
				peak = Math.max(peak, ++open);
				try {
					return await readFile(filePath, encoding);
				} finally {
					open--;
				}
			};
			const read = createStudioConfigurationReader(captureWarnings().logger, countingReadFile);
			const results = await Promise.all(Array.from({ length: 20 }, () => read()));
			for (const configuration of results) assert.strictEqual(configuration.pages.length, 60);
			assert.ok(peak > 1 && peak <= 8, `peak concurrent reads was ${peak}`);
		});

		it('never let a caller that reads again on completion overtake callers already waiting', async () => {
			const read = createStudioConfigurationReader(captureWarnings().logger);
			writeComponent('app', 'studio:\n  pages: [{ id: p, name: P, placement: tab }]\n');
			const first = read();
			let waitingDone = false;
			const waiting = read().then(() => (waitingDone = true));
			let repeatScans = 0;
			const repeating = (async () => {
				await first;
				while (!waitingDone && repeatScans < 5) {
					repeatScans++;
					await read();
				}
			})();
			await Promise.all([waiting, repeating]);
			assert.strictEqual(repeatScans, 1);
		});
	});

	describe('written with set_configuration and read back in the same process', () => {
		it('returns the block set_configuration wrote, with no restart', async () => {
			writeComponent('harper-redirects', redirectsConfig);
			const response = await setConfiguration({
				operation: 'set_configuration',
				studio_navigation: { applications: 'hidden', apis: 'hidden', operations: 'tucked' },
				studio_landing: 'harper-redirects.redirects',
			});
			assert.match(response, /successfully/);
			assert.deepStrictEqual(readRootConfig().studio, {
				navigation: { applications: 'hidden', apis: 'hidden', operations: 'tucked' },
				landing: 'harper-redirects.redirects',
			});
			const configuration = await getStudioConfiguration();
			assert.deepStrictEqual(configuration.navigation, {
				applications: 'hidden',
				apis: 'hidden',
				operations: 'tucked',
			});
			assert.strictEqual(configuration.landing, 'harper-redirects.redirects');
			assert.strictEqual(configuration.pages.length, 2);
		});

		it("accepts a component page's <component>.<pageId> as a navigation key and as the landing page", async () => {
			const navigation = {
				'applications': 'hidden',
				'harper-redirects.redirects': 'tucked',
				'Dev_App-2.page': 'hidden',
				'my.dotted.app.page': 'visible',
			};
			await setConfiguration({
				operation: 'set_configuration',
				studio_navigation: navigation,
				studio_landing: 'harper-redirects.redirects',
			});
			const configuration = await getStudioConfiguration();
			assert.deepStrictEqual(configuration.navigation, navigation);
			assert.strictEqual(configuration.landing, 'harper-redirects.redirects');
		});

		for (const key of [
			'harper-redirects.Redirects',
			'harper redirects.redirects',
			'harper-redirects.',
			'.harper-redirects.redirects',
			'app/nested.page',
			'harper-redirects.redirects!',
			'@scope.page',
		]) {
			it(`refuses the navigation key ${JSON.stringify(key)}`, async () => {
				await assert.rejects(
					setConfiguration({ operation: 'set_configuration', studio_navigation: { [key]: 'tucked' } }),
					(error) =>
						error.statusCode === 400 && /studio\.navigation has a key that is neither a tab key nor/.test(error.message)
				);
			});
		}

		it('reads a <component>.<pageId> key an env layer nested on its dot', async () => {
			setRootConfigEntry('studio', {
				navigation: {
					'logs': 'hidden',
					'harper-redirects': { redirects: 'tucked' },
					'my': { dotted: { app: { page: 'hidden' } } },
				},
			});
			assert.deepStrictEqual((await getStudioConfiguration()).navigation, {
				'logs': 'hidden',
				'harper-redirects.redirects': 'tucked',
				'my.dotted.app.page': 'hidden',
			});
		});

		it('drops a nested navigation map a YAML alias makes refer to itself', async () => {
			writeFileSync(
				getConfigFilePath(),
				`${readFileSync(getConfigFilePath(), 'utf8')}\nstudio:\n  navigation:\n    app: &loop\n      again: *loop\n    apis: hidden\n`
			);
			const { warnings, logger } = captureWarnings();
			assert.deepStrictEqual((await createStudioConfigurationReader(logger)()).navigation, { apis: 'hidden' });
			assert.match(warnings[0], /studio\.navigation holds a value that refers to itself/);
		});

		it('accepts navigation as JSON text, and replaces the whole map', async () => {
			await setConfiguration({ operation: 'set_configuration', studio_navigation: { logs: 'hidden', apis: 'hidden' } });
			await setConfiguration({
				operation: 'set_configuration',
				STUDIO_NAVIGATION: JSON.stringify({ status: 'tucked' }),
			});
			assert.deepStrictEqual((await getStudioConfiguration()).navigation, { status: 'tucked' });
		});

		it('clears back to the defaults', async () => {
			await setConfiguration({
				operation: 'set_configuration',
				studio_navigation: { logs: 'hidden' },
				studio_landing: 'logs',
			});
			await setConfiguration({ operation: 'set_configuration', studio_navigation: {}, studio_landing: null });
			assert.deepStrictEqual(await getStudioConfiguration(), { pages: [] });
		});

		it('writes a value back after a restart took it as the startup value', async () => {
			const configPath = getConfigFilePath();
			const saved = readFileSync(configPath, 'utf8');
			try {
				await setConfiguration({
					operation: 'set_configuration',
					studio_landing: 'databases',
					studio_navigation: { logs: 'hidden' },
				});
				initConfig(true);
				await setConfiguration({
					operation: 'set_configuration',
					studio_landing: 'logs',
					studio_navigation: { logs: 'tucked' },
				});
				await setConfiguration({
					operation: 'set_configuration',
					studio_landing: 'databases',
					studio_navigation: { logs: 'hidden' },
				});
				const configuration = await getStudioConfiguration();
				assert.strictEqual(configuration.landing, 'databases');
				assert.deepStrictEqual(configuration.navigation, { logs: 'hidden' });
			} finally {
				writeFileSync(configPath, saved);
				initConfig(true);
			}
		});

		for (const [fields, problem] of [
			[{ studio_navigation: { logs: 'gone' } }, /studio\.navigation\.logs must be visible, tucked or hidden/],
			[{ studio_navigation: 'hidden' }, /studio\.navigation must be a map/],
			[
				{ studio_navigation: { Logs: 'hidden' } },
				/studio\.navigation has a key that is neither a tab key nor <component>\.<pageId>/,
			],
			[
				{ studio_navigation: { 'Bad_Key!': null } },
				/studio\.navigation has a key that is neither a tab key nor <component>\.<pageId>/,
			],
			[{ studio_navigation: { logs: null } }, /studio\.navigation\.logs must be visible, tucked or hidden/],
			[{ studio_landing: '' }, /studio\.landing must be a tab key or <component>\.<pageId>/],
			[{ studio_landing: { page: 'x' } }, /studio\.landing must be a tab key or <component>\.<pageId>/],
			[{ studio_landing: 'harper-redirects.Redirects' }, /studio\.landing must be a tab key or <component>\.<pageId>/],
			[{ studio_landing: 'not a page' }, /studio\.landing must be a tab key or <component>\.<pageId>/],
		]) {
			it(`refuses ${JSON.stringify(fields)} without writing any part of the request`, async () => {
				const before = readFileSync(getConfigFilePath(), 'utf8');
				await assert.rejects(
					setConfiguration({ operation: 'set_configuration', logging_level: 'fatal', ...fields }),
					(error) => error.statusCode === 400 && problem.test(error.message)
				);
				assert.strictEqual(readFileSync(getConfigFilePath(), 'utf8'), before);
			});
		}

		it('replaces a root studio value that is not a map rather than reporting a write that did not land', async () => {
			setRootConfigEntry('studio', 'hidden');
			await setConfiguration({
				operation: 'set_configuration',
				studio_navigation: { logs: 'hidden' },
				studio_landing: 'databases',
			});
			assert.deepStrictEqual(readRootConfig().studio, { navigation: { logs: 'hidden' }, landing: 'databases' });
		});

		for (const [layer, pinned] of [
			['HARPER_SET_CONFIG', { studio: null }],
			['HARPER_CONFIG', { studio: false }],
		]) {
			it(`refuses a write ${layer} would replace at the next start by setting the whole studio block`, async () => {
				const saved = process.env[layer];
				process.env[layer] = JSON.stringify(pinned);
				try {
					await assert.rejects(
						setConfiguration({ operation: 'set_configuration', studio_landing: 'logs' }),
						(error) => error.statusCode === 409 && error.message.includes(layer)
					);
				} finally {
					if (saved === undefined) delete process.env[layer];
					else process.env[layer] = saved;
				}
			});
		}

		for (const layer of ['HARPER_SET_CONFIG', 'HARPER_CONFIG']) {
			it(`refuses a write ${layer} would put back at the next start`, async () => {
				const saved = process.env[layer];
				const before = readFileSync(getConfigFilePath(), 'utf8');
				process.env[layer] = JSON.stringify({ studio: { navigation: { logs: 'hidden' } } });
				try {
					await assert.rejects(
						setConfiguration({ operation: 'set_configuration', studio_navigation: { logs: 'tucked' } }),
						(error) => error.statusCode === 409 && error.message.includes(layer)
					);
					assert.strictEqual(readFileSync(getConfigFilePath(), 'utf8'), before);
					await setConfiguration({ operation: 'set_configuration', studio_landing: 'logs' });
					assert.strictEqual(readRootConfig().studio.landing, 'logs', 'a key the layer does not name is writable');
				} finally {
					if (saved === undefined) delete process.env[layer];
					else process.env[layer] = saved;
				}
			});
		}

		it('accepts a write over settings HARPER_DEFAULT_CONFIG supplied', async () => {
			const saved = process.env.HARPER_DEFAULT_CONFIG;
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ 'studio.navigation.logs': 'hidden' });
			try {
				await setConfiguration({ operation: 'set_configuration', studio_navigation: { logs: 'tucked' } });
				assert.deepStrictEqual(readRootConfig().studio.navigation, { logs: 'tucked' });
			} finally {
				if (saved === undefined) delete process.env.HARPER_DEFAULT_CONFIG;
				else process.env.HARPER_DEFAULT_CONFIG = saved;
			}
		});

		it('refuses a nested studio block, which would replace an application entry of that name', async () => {
			await assert.rejects(
				setConfiguration({ operation: 'set_configuration', studio: { landing: 'logs' } }),
				(error) => error.statusCode === 400 && /unrecognized config parameter: studio/.test(error.message)
			);
		});

		it('is not applied from a bare env var or CLI arg of the same name at boot', () => {
			assert.strictEqual(CONFIG_PARAM_MAP.studio_navigation, undefined);
			assert.strictEqual(CONFIG_PARAM_MAP.studio_landing, undefined);
		});
	});

	describe('the component loader', () => {
		it('loads a component that declares Studio pages without failing or treating studio as a plugin', async () => {
			const componentLoader = require('#src/components/componentLoader');
			const { statusForComponent } = require('#src/components/status/index');
			const directory = writeComponent(
				'studio-only-app',
				'studio:\n  pages: [{ id: page, name: Page, placement: tab, content: { kind: sections } }]\n'
			);
			await componentLoader.loadComponent(directory, { isWorker: true, set() {} }, 'test-origin');
			assert.strictEqual(statusForComponent('studio-only-app.studio').get()?.status, 'healthy');
			assert.notStrictEqual(statusForComponent('studio-only-app').get()?.status, 'error');
		});
	});
});
