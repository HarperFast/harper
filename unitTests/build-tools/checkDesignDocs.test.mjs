import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	CEILING_SLACK,
	CEILINGS_FILE,
	DESIGN_BUDGET,
	MAP_BUDGET,
	MAP_LINES,
	checkDesignDocs,
	classifySpan,
	codeSpans,
	staleReport,
	updateCeilings,
} from '../../build-tools/check-design-docs.mjs';

const CLI = resolve(import.meta.dirname, '../../build-tools/check-design-docs.mjs');
const DEADLINE = 60_000;

const INDEX = '- [Note](lib/DESIGN.md#note) — one line.\n';
const NOTE = '## Note\n\nThe invariant.\n';
const SOURCE = `export function makeStore(options) {
	const cache = new Map();
	// #section: reads
	class Store {
		get(id) {
			return cache.get(id);
		}
		// #section: writes
		put(id, value) {
			cache.set(id, value);
		}
	}
	return Store;
}
`;
const MAP = [
	'# lib/ map',
	'',
	'- `store.ts` — the store factory, `makeStore()`.',
	'- reading a record → `Store.get`; the write path → `#section: writes`; the cache → `cache`.',
	'- symbol inventory: `npm run outline -- lib/store.ts`; `true`, `null` and `await` are not symbols; `schema.graphql` is a file; `makeStore.Store.get` is nested.',
	'',
	'```',
	'`notAName` inside a fence is ignored',
	'```',
	'',
].join('\n');
const AGENTS = '- [lib/ map](lib/MAP.md)\n';

const sized = (bytes) => `## Note\n${'x'.repeat(bytes - 9)}\n`;

function createTree(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'design-docs-'));
	write(dir, { 'DESIGN.md': INDEX, 'lib/DESIGN.md': NOTE, ...files });
	return dir;
}
function write(dir, files) {
	for (const [file, content] of Object.entries(files)) {
		const full = join(dir, file);
		if (content === null) rmSync(full);
		else {
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content);
		}
	}
}
const ceilings = (entries) => `${JSON.stringify(entries, null, '\t')}\n`;
const mapTree = (files = {}) =>
	createTree({
		'lib/store.ts': SOURCE,
		'lib/schema.graphql': 'type Store {}\n',
		'lib/MAP.md': MAP,
		'lib/CLAUDE.md': '@MAP.md\n',
		'AGENTS.md': AGENTS,
		...files,
	});

function isolatedGit(dir) {
	const config = join(dir, '.git-test-config');
	writeFileSync(
		config,
		'[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[user]\n\tname = Test\n\temail = test@example.com\n'
	);
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_NOSYSTEM: '1',
	};
	const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: DEADLINE }).trim();
	writeFileSync(join(dir, '.gitignore'), '.git-test-config\n');
	git('init', '-q');
	const commit = (message) => {
		git('add', '-A');
		git('commit', '-q', '-m', message);
		return git('rev-parse', 'HEAD');
	};
	return { git, commit };
}

describe('build-tools/check-design-docs.mjs', function () {
	let dir;
	afterEach(function () {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});
	const errorsOf = async (options = {}) => (await checkDesignDocs({ root: dir, ...options })).errors;

	it('passes a tree within its budgets', async function () {
		dir = createTree();
		assert.deepStrictEqual(await errorsOf(), []);
	});

	describe('byte budgets', function () {
		it('fails a two-line DESIGN.md over 40 KiB that the old 1000-line budget let through', async function () {
			dir = createTree({ 'lib/DESIGN.md': sized(DESIGN_BUDGET + 1) });
			const errors = await errorsOf();
			assert.strictEqual(errors.length, 1, errors.join('\n'));
			assert.match(errors[0], /lib\/DESIGN\.md is 40,961 bytes, over its budget of 40,960/);
		});

		it('allows exactly the budget, counting UTF-8 bytes and ignoring CRLF', async function () {
			dir = createTree({ 'lib/DESIGN.md': sized(DESIGN_BUDGET) });
			assert.deepStrictEqual(await errorsOf(), []);
			write(dir, { 'lib/DESIGN.md': sized(DESIGN_BUDGET).replace(/\n/g, '\r\n') });
			assert.deepStrictEqual(await errorsOf(), []);
			write(dir, { 'lib/DESIGN.md': `## Note\n${'é'.repeat(DESIGN_BUDGET / 2)}\n` });
			assert.match((await errorsOf()).join('\n'), /over its budget/);
		});

		it('holds DESIGN.md files under test directories, but not under fixtures', async function () {
			dir = createTree({
				'unitTests/DESIGN.md': sized(DESIGN_BUDGET + 1),
				'unitTests/fixtures/app/DESIGN.md': sized(DESIGN_BUDGET + 1),
				'DESIGN.md': `${INDEX}- [Tests](unitTests/DESIGN.md#note) — tests.\n`,
			});
			const errors = await errorsOf();
			assert.strictEqual(errors.length, 1, errors.join('\n'));
			assert.match(errors[0], /^unitTests\/DESIGN\.md is 40,961 bytes/);
		});

		it('holds the root index to the same budget', async function () {
			dir = createTree({ 'DESIGN.md': `${INDEX}${'x'.repeat(DESIGN_BUDGET)}\n` });
			assert.match((await errorsOf()).join('\n'), /^DESIGN\.md is [\d,]+ bytes, over its budget/);
		});
	});

	describe('ceilings', function () {
		const over = DESIGN_BUDGET + 10 * 1024;
		const withCeiling = (size, ceiling, extra = {}) =>
			createTree({ 'lib/DESIGN.md': sized(size), [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': ceiling }), ...extra });

		it('lets a file over budget sit at or just under its ceiling', async function () {
			dir = withCeiling(over, over);
			assert.deepStrictEqual(await errorsOf(), []);
			write(dir, { 'lib/DESIGN.md': sized(over - CEILING_SLACK) });
			assert.deepStrictEqual(await errorsOf(), [], 'a trim of up to the slack needs no ceiling change');
		});

		it('fails a file that grows past its ceiling', async function () {
			dir = withCeiling(over + 1, over);
			assert.match((await errorsOf()).join('\n'), /over its ceiling of [\d,]+ — prune it/);
		});

		it('fails a trim that leaves the ceiling more than the slack above the file', async function () {
			dir = withCeiling(over - CEILING_SLACK - 1, over);
			assert.match((await errorsOf()).join('\n'), /under its ceiling .* --update-ceilings/);
		});

		it('fails a spent ceiling, a ceiling for a missing file, and one for a non-DESIGN.md file', async function () {
			dir = withCeiling(100, over);
			assert.match((await errorsOf()).join('\n'), /within the [\d,]+-byte budget, so its ceiling is spent/);
			write(dir, { [CEILINGS_FILE]: ceilings({ 'gone/DESIGN.md': over, 'lib/NOTES.md': over }) });
			const errors = (await errorsOf()).join('\n');
			assert.match(errors, /lists gone\/DESIGN\.md, which does not exist/);
			assert.match(errors, /lists lib\/NOTES\.md; only DESIGN\.md files get ceilings/);
		});

		it('rejects a ceilings file that is not path → positive integer', async function () {
			for (const bad of [
				'[]',
				ceilings({ 'lib/DESIGN.md': 0 }),
				ceilings({ 'lib/DESIGN.md': 1.5 }),
				ceilings({ 'lib/DESIGN.md': '1' }),
			]) {
				dir = createTree({ [CEILINGS_FILE]: bad });
				await assert.rejects(errorsOf(), /must be/);
				rmSync(dir, { recursive: true, force: true });
			}
			dir = undefined;
		});

		it('--update-ceilings records every DESIGN.md over budget at its size and drops the rest', async function () {
			dir = createTree({
				'lib/DESIGN.md': sized(over),
				'other/DESIGN.md': sized(DESIGN_BUDGET),
				'DESIGN.md': `${INDEX}- [Other](other/DESIGN.md#note) — another.\n`,
				[CEILINGS_FILE]: ceilings({ 'other/DESIGN.md': over }),
			});
			assert.deepStrictEqual(updateCeilings({ root: dir }), { 'lib/DESIGN.md': over });
			assert.strictEqual(readFileSync(join(dir, CEILINGS_FILE), 'utf8'), ceilings({ 'lib/DESIGN.md': over }));
			assert.deepStrictEqual(await errorsOf(), []);
		});

		it('--update-ceilings lowers a ceiling but never raises one', function () {
			dir = withCeiling(over + 500, over);
			assert.deepStrictEqual(updateCeilings({ root: dir }), { 'lib/DESIGN.md': over });
			write(dir, { 'lib/DESIGN.md': sized(over - 2048) });
			assert.deepStrictEqual(updateCeilings({ root: dir }), { 'lib/DESIGN.md': over - 2048 });
		});
	});

	describe('--base', function () {
		const over = DESIGN_BUDGET + 4096;
		let git;
		let commit;
		let base;
		beforeEach(function () {
			dir = createTree({
				'lib/DESIGN.md': sized(over),
				'big/DESIGN.md': '## Big\n',
				'DESIGN.md': `${INDEX}- [Big](big/DESIGN.md#big) — another.\n`,
				'lib/code.ts': 'export const a = 1;\n',
				[CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over }),
			});
			({ git, commit } = isolatedGit(dir));
			base = commit('base');
		});

		it('rejects a raised or new ceiling that the tree alone would accept', async function () {
			write(dir, { [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over + 100 }) });
			assert.deepStrictEqual(await errorsOf(), []);
			assert.match(
				(await errorsOf({ base })).join('\n'),
				/raises lib\/DESIGN\.md from [\d,]+ to [\d,]+; a ceiling only ever falls/
			);
			write(dir, {
				'big/DESIGN.md': sized(over),
				[CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over, 'big/DESIGN.md': over }),
			});
			assert.match((await errorsOf({ base })).join('\n'), /adds a ceiling for big\/DESIGN\.md/);
		});

		it('accepts a lowered ceiling and skips the ratchet when the base has no ceilings file', async function () {
			write(dir, { 'lib/DESIGN.md': sized(over - 2048), [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over - 2048 }) });
			assert.deepStrictEqual(await errorsOf({ base }), []);
			write(dir, { [CEILINGS_FILE]: null, 'lib/DESIGN.md': sized(over) });
			const bootstrap = commit('no ceilings');
			write(dir, { [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over }) });
			assert.deepStrictEqual(await errorsOf({ base: bootstrap }), []);
		});

		it('holds only the files a change touches to their ceilings, warning about the rest', async function () {
			write(dir, { 'lib/DESIGN.md': sized(over + 100) });
			commit('a stale-CI merge left lib/DESIGN.md over its ceiling');
			const head = git('rev-parse', 'HEAD');
			write(dir, { 'lib/code.ts': 'export const a = 2;\n' });
			const unrelated = await checkDesignDocs({ root: dir, base: head });
			assert.deepStrictEqual(unrelated.errors, []);
			assert.match(
				unrelated.warnings.join('\n'),
				/lib\/DESIGN\.md is [\d,]+ bytes, over its ceiling .*not failing this change/
			);
			assert.match((await errorsOf()).join('\n'), /over its ceiling/, 'without --base every file is held');
			write(dir, { 'lib/DESIGN.md': `${sized(over + 100)}more\n` });
			assert.match((await errorsOf({ base: head })).join('\n'), /over its ceiling/);
		});

		it('holds every ceilinged file when the ceilings file itself changes', async function () {
			write(dir, {
				'big/DESIGN.md': sized(over),
				[CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over, 'big/DESIGN.md': over }),
			});
			const head = commit('big grows with a ceiling');
			write(dir, { [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over - 10, 'big/DESIGN.md': over }) });
			assert.match((await errorsOf({ base: head })).join('\n'), /lib\/DESIGN\.md is [\d,]+ bytes, over its ceiling/);
		});

		it('rejects dropping the ceiling of a file still over budget, or deleting the ceilings file', async function () {
			write(dir, { [CEILINGS_FILE]: '{}\n' });
			assert.match(
				(await errorsOf({ base })).join('\n'),
				/drops the ceiling for lib\/DESIGN\.md, which is still over the [\d,]+-byte budget/
			);
			write(dir, { [CEILINGS_FILE]: null });
			const errors = (await errorsOf({ base })).join('\n');
			assert.match(errors, /design-docs-ceilings\.json was deleted/);
			assert.match(errors, /lib\/DESIGN\.md is [\d,]+ bytes, over its budget/);
		});

		it('counts a deleted ceilinged file as changed', async function () {
			write(dir, { 'lib/DESIGN.md': null, 'DESIGN.md': '- [Big](big/DESIGN.md#big) — another.\n' });
			assert.match((await errorsOf({ base })).join('\n'), /lists lib\/DESIGN\.md, which does not exist/);
		});

		it('fails on a base that does not resolve rather than skipping the ratchet', async function () {
			await assert.rejects(errorsOf({ base: 'no-such-ref' }), /--base no-such-ref does not resolve to a commit/);
		});
	});

	describe('directory maps', function () {
		it('passes a map whose names resolve in its directory', async function () {
			dir = mapTree();
			assert.deepStrictEqual(await errorsOf(), []);
		});

		it('fails a map naming a symbol, member, path or section its directory does not declare', async function () {
			dir = mapTree({
				'lib/MAP.md': `${MAP}- \`Missing\`, \`Other.get\`, \`gone.ts\`, \`#section: nowhere\` and \`store.ts:5\`.\n`,
			});
			const errors = (await errorsOf()).join('\n');
			assert.strictEqual(errors.split('\n').length, 5, errors);
			assert.match(errors, /lib\/MAP\.md:10 `Missing`: not declared in lib\/ source/);
			assert.match(errors, /`Other\.get`: not declared/);
			assert.match(errors, /`gone\.ts`: no such file/);
			assert.match(errors, /`#section: nowhere`: no `\/\/ #section: nowhere` marker/);
			assert.match(errors, /`store\.ts:5`: MAP\.md names symbols, not line numbers/);
			assert.doesNotMatch(errors, /notAName|`true`|`null`|outline/);
		});

		it('checks the symbol of a `file:symbol` span in that file, and a call span even when it is a keyword', async function () {
			dir = mapTree({
				'lib/store.ts': SOURCE.replace('put(id, value)', 'delete(id, value)'),
				'lib/MAP.md': `${MAP}- \`store.ts:Store.get\`, \`store.ts:Store.read\`, \`delete()\` and \`return()\`.\n`,
			});
			const errors = (await errorsOf()).join('\n');
			assert.match(errors, /`store\.ts:Store\.read`: not declared in lib\/store\.ts/);
			assert.match(errors, /`return\(\)`: not declared/);
			assert.doesNotMatch(errors, /Store\.get`|`delete/);
		});

		it('requires a dotted name to be declared directly in its qualifier', async function () {
			dir = mapTree({ 'lib/MAP.md': `${MAP}- \`makeStore.get\` and \`Store.cache\`.\n` });
			const errors = (await errorsOf()).join('\n');
			assert.match(errors, /`makeStore\.get`: not declared/);
			assert.match(errors, /`Store\.cache`: not declared/);
		});

		it('fails an unchanged map once the source renames what it names', async function () {
			dir = mapTree({ 'lib/store.ts': SOURCE.replace('get(id)', 'read(id)') });
			assert.match((await errorsOf()).join('\n'), /`Store\.get`: not declared/);
		});

		it('requires CLAUDE.md to be exactly @MAP.md', async function () {
			dir = mapTree({ 'lib/CLAUDE.md': '@MAP.md\nAlso read DESIGN.md.\n' });
			assert.match((await errorsOf()).join('\n'), /lib\/CLAUDE\.md must be exactly `@MAP\.md`/);
			write(dir, { 'lib/CLAUDE.md': null });
			assert.match((await errorsOf()).join('\n'), /lib\/MAP\.md needs lib\/CLAUDE\.md/);
		});

		it('requires AGENTS.md to link the map, and rejects a root map', async function () {
			dir = mapTree({ 'AGENTS.md': 'no maps listed\n', 'MAP.md': '# root\n' });
			const errors = (await errorsOf()).join('\n');
			assert.match(errors, /lib\/MAP\.md is not linked from AGENTS\.md/);
			assert.match(errors, /MAP\.md at the repository root/);
		});

		it('holds a map to 80 lines and 8 KiB', async function () {
			const lines = (n) => Array.from({ length: n }, (_, i) => `- line ${i}`).join('\n');
			dir = mapTree({ 'lib/MAP.md': `${lines(MAP_LINES)}\n` });
			assert.deepStrictEqual(await errorsOf(), []);
			write(dir, { 'lib/MAP.md': lines(MAP_LINES) });
			assert.deepStrictEqual(await errorsOf(), [], 'no final newline is still 80 lines');
			write(dir, { 'lib/MAP.md': `${lines(MAP_LINES + 1)}\n` });
			assert.match((await errorsOf()).join('\n'), /lib\/MAP\.md is 81 lines/);
			write(dir, { 'lib/MAP.md': `- ${'x'.repeat(MAP_BUDGET)}\n` });
			assert.match((await errorsOf()).join('\n'), /lib\/MAP\.md is [\d,]+ bytes, over its budget of 8,192/);
		});
	});

	describe('--stale', function () {
		it('lists names the repository once had and no longer does, and files over ceiling', async function () {
			dir = createTree({
				'lib/old.ts': 'export function retiredHelper() {}\n// #section: retired\n',
				'lib/methods.ts': 'export class Methods {\n\tdelete() {}\n\tremovedMethod() {}\n}\n',
				'lib/keep.ts': [
					'export function keptHelper() {}',
					'const key = "configuredName";',
					'// commentOnlyName',
					'const a = 1;// trailingComment',
					'const b = 2; /* blockComment */',
					'const c = 1// tightComment',
					'const t = `${a} text`; // templateComment',
					"const s = '/* inStringName */';",
					'const current = 1;',
					'',
				].join('\n'),
				'lib/schema.graphql': 'type Retired {}\n',
				'lib/current.graphql': 'type Current {}\n',
			});
			const { commit } = isolatedGit(dir);
			commit('add helpers');
			write(dir, {
				'lib/old.ts': null,
				'lib/schema.graphql': null,
				'lib/keep.ts': 'export function keptHelper() {}\nconst key = "configuredName";\n',
				'lib/methods.ts': 'export class Methods {\n\tremove() {}\n}\n',
				'big/DESIGN.md': sized(DESIGN_BUDGET + 1),
				'DESIGN.md': `${INDEX}- [Big](big/DESIGN.md#note) — big.\n`,
				'lib/DESIGN.md': `${NOTE}\nNames: \`retiredHelper()\`, \`lib/old.ts\`, \`#section: retired\`, \`keptHelper\`, \`configuredName\`, \`commentOnlyName\`, \`neverHadThis()\`, \`otherRepo.ts\`, \`mdb_env_open\`.\n\nMethods: \`delete()\`, \`lib/methods.ts:removedMethod\`, \`lib/methods.ts:remove\`, \`Methods.removedMethod\`, \`schema.graphql\`, \`current.graphql\`, \`trailingComment\`, \`blockComment\`, \`tightComment\`, \`templateComment\`, \`inStringName\`.\n`,
			});
			commit('retire old.ts');
			const report = await staleReport({ root: dir });
			assert.match(report, /- `big\/DESIGN\.md`: 40,961 bytes, budget 40,960/);
			assert.match(
				report,
				/### `lib\/DESIGN\.md`\n\n- line 5: `retiredHelper\(\)` \(symbol\)\n- line 5: `lib\/old\.ts` \(path\)\n- line 5: `#section: retired` \(section\)\n- line 7: `delete\(\)` \(symbol\)\n- line 7: `lib\/methods\.ts:removedMethod` \(symbol\)\n- line 7: `Methods\.removedMethod` \(symbol\)\n- line 7: `schema\.graphql` \(path\)\n- line 7: `inStringName` \(symbol\)\n\n/
			);
			for (const live of [
				'keptHelper',
				'configuredName',
				'commentOnlyName',
				'current.graphql',
				'trailingComment',
				'blockComment',
				'tightComment',
				'templateComment',
				'neverHadThis',
				'otherRepo',
				'mdb_env_open',
			])
				assert.doesNotMatch(report, new RegExp(`\`${live}`), live);
		});

		it('lists unresolved MAP.md names under their own heading, and caps the report on request', async function () {
			dir = mapTree({ 'lib/MAP.md': `${MAP}- \`Missing\`.\n` });
			isolatedGit(dir).commit('map');
			const report = await staleReport({ root: dir });
			assert.match(report, /^## Map references that do not resolve\n\n1 backticked names/);
			assert.match(report, /- line 10: `Missing` \(not declared in lib\/ source\)/);
			assert.doesNotMatch(report, /Dead references/);
			const capped = await staleReport({ root: dir, limit: 60 });
			assert.match(capped, /- … 1 more not shown; run `npm run check:design-docs -- --stale` for the full list\.\n$/);
		});

		it('is empty for a clean tree and exits 0 either way', async function () {
			dir = createTree({ 'lib/a.ts': 'export const a = 1;\n' });
			isolatedGit(dir).commit('clean');
			assert.strictEqual(await staleReport({ root: dir }), '');
			const result = spawnSync(process.execPath, [CLI, '--stale', '--root', dir], {
				encoding: 'utf8',
				timeout: DEADLINE,
			});
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(result.stdout, '');
		});
	});

	describe('CLI', function () {
		const run = (...args) =>
			spawnSync(process.execPath, [CLI, '--root', dir, ...args], { encoding: 'utf8', timeout: DEADLINE });

		it('exits 0 when the tree passes, 1 with errors, 2 when it cannot check', function () {
			dir = createTree();
			assert.strictEqual(run().status, 0);
			write(dir, { 'lib/DESIGN.md': sized(DESIGN_BUDGET + 1) });
			const failed = run();
			assert.strictEqual(failed.status, 1);
			assert.match(failed.stderr, /^error: lib\/DESIGN\.md is 40,961 bytes/m);
			const unresolved = run('--base', 'no-such-ref');
			assert.strictEqual(unresolved.status, 2);
			assert.match(unresolved.stderr, /^error: --base no-such-ref does not resolve/m);
			assert.strictEqual(run('--bogus').status, 2);
		});

		it('--update-ceilings writes the ceilings that make the tree pass', function () {
			dir = createTree({ 'lib/DESIGN.md': sized(DESIGN_BUDGET + 1), [CEILINGS_FILE]: '{}\n' });
			assert.strictEqual(run('--update-ceilings').status, 0);
			assert.strictEqual(run().status, 0);
		});
	});

	describe('markdown references', function () {
		it('reads inline code spans outside fences', function () {
			assert.deepStrictEqual(
				codeSpans('a `one` b ``two `x` two`` c\n~~~\n`fenced`\n~~~\n```js\n`also`\n```\n`after`\n'),
				[
					{ text: 'one', line: 1 },
					{ text: 'two `x` two', line: 1 },
					{ text: 'after', line: 8 },
				]
			);
		});

		it('classifies sections, paths and symbols, and skips everything else', function () {
			assert.deepStrictEqual(classifySpan('#section: read-path'), { type: 'section', name: 'read-path' });
			assert.deepStrictEqual(classifySpan('resources/Table.ts'), {
				type: 'path',
				path: 'resources/Table.ts',
				line: false,
			});
			assert.deepStrictEqual(classifySpan('./Table.ts:120-130'), { type: 'path', path: 'Table.ts', line: true });
			assert.deepStrictEqual(classifySpan('utility/mount_hdb.ts:createTables'), {
				type: 'path',
				path: 'utility/mount_hdb.ts',
				line: false,
				symbol: ['createTables'],
			});
			assert.deepStrictEqual(classifySpan('store.ts:find(#L1)'), {
				type: 'path',
				path: 'store.ts',
				line: false,
				symbol: ['find'],
			});
			assert.deepStrictEqual(classifySpan('Table.ts#L10-L20'), { type: 'path', path: 'Table.ts', line: true });
			assert.deepStrictEqual(classifySpan('store.ts:missing()'), {
				type: 'path',
				path: 'store.ts',
				line: false,
				symbol: ['missing'],
			});
			assert.deepStrictEqual(classifySpan('sub/missing.graphql'), {
				type: 'path',
				path: 'sub/missing.graphql',
				line: false,
			});
			assert.deepStrictEqual(classifySpan('schema.graphql:5'), { type: 'path', path: 'schema.graphql', line: true });
			assert.deepStrictEqual(classifySpan('my-schema.graphql'), {
				type: 'path',
				path: 'my-schema.graphql',
				line: false,
			});
			assert.deepStrictEqual(classifySpan('TableResource._writeUpdate'), {
				type: 'symbol',
				parts: ['TableResource', '_writeUpdate'],
				call: false,
			});
			assert.deepStrictEqual(classifySpan('makeTable(options)'), { type: 'symbol', parts: ['makeTable'], call: true });
			assert.deepStrictEqual(classifySpan('#lockHandle'), { type: 'symbol', parts: ['#lockHandle'], call: false });
			for (const other of [
				'null',
				'true',
				'.ts',
				'text/event-stream',
				'node:fs',
				'npm run outline -- <file>',
				'X-Replicate-To',
				'@relationship',
				'https://x.io/a.md',
				'v5.3',
				'5.4.0',
				'*.test.js',
			])
				assert.strictEqual(classifySpan(other), undefined, other);
		});
	});
});
