import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	CEILING_HEADROOM,
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

// Many one-letter words, so a smaller or larger version of the file reads as a cut or an addition, not a rewrite.
const sized = (bytes) => `## Note\n${'x '.repeat(bytes).slice(0, bytes - 9)}\n`;
// About `bytes` of prose whose words no other `seed` uses.
const prose = (seed, bytes) => {
	let text = '';
	for (let i = 0; text.length < bytes; i++) text += ` ${seed}${i}`;
	return `${text.slice(1, bytes)}\n`;
};
const bytesOf = (text) => Buffer.byteLength(text);
const formatted = (n) => n.toLocaleString('en-US');

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

	describe('links and anchors', function () {
		const note = (extra) => `${NOTE}\n${extra}\n`;
		const TOPIC = '# Topic\n\n## Part\n\nBody.\n';
		const withTopic = { 'DESIGN.md': `${INDEX}- [Part](lib/topic.md#part) — x\n`, 'lib/topic.md': TOPIC };
		const errorsFor = async (files) => {
			if (dir) rmSync(dir, { recursive: true, force: true });
			dir = createTree(files);
			return (await errorsOf()).join('\n');
		};
		const passes = async (files) => assert.strictEqual(await errorsFor(files), '');
		const fails = async (files, message) => assert.match(await errorsFor(files), message);

		describe('the index', function () {
			it('rejects a section of a note that the index does not link', async function () {
				await fails(
					{ 'lib/DESIGN.md': note('## Other') },
					/lib\/DESIGN\.md section "Other" is not indexed in DESIGN\.md/
				);
			});

			it('rejects an index link to a missing file, and to a heading that is not ##', async function () {
				await fails(
					{ 'DESIGN.md': `${INDEX}- [Gone](lib/gone.md#x) — x\n` },
					/^DESIGN\.md:2 links to missing file lib\/gone\.md/
				);
				await fails(
					{ 'DESIGN.md': `${INDEX}- [Sub](lib/DESIGN.md#sub) — x\n`, 'lib/DESIGN.md': note('### Sub') },
					/^DESIGN\.md:2 links to lib\/DESIGN\.md#sub, which no ## heading there produces/
				);
			});

			it('requires every ## section of a markdown file that an index entry links to', async function () {
				await passes(withTopic);
				await fails(
					{ ...withTopic, 'lib/topic.md': `${TOPIC}\n## Other\n` },
					/lib\/topic\.md section "Other" is not indexed in DESIGN\.md/
				);
			});

			it('checks a link in the index prose without registering its target, but registers the target of an entry', async function () {
				await passes({
					'DESIGN.md': `See [the guide](GUIDE.md#guide).\n${INDEX}`,
					'GUIDE.md': '# Guide\n\n## Unindexed section\n',
				});
				await fails(
					{ 'DESIGN.md': `See [the guide](GONE.md).\n${INDEX}` },
					/^DESIGN\.md:1 links to missing file GONE\.md/
				);
				await fails(
					{ 'DESIGN.md': `${INDEX.trimEnd()} See [the guide](GUIDE.md).\n`, 'GUIDE.md': '# Guide\n\n## Part\n' },
					/GUIDE\.md section "Part" is not indexed/
				);
			});

			it('registers the target of an entry written with any list marker', async function () {
				for (const marker of ['- ', '* ', '+ ', '1. ', '2) ', '-\t'])
					await fails(
						{
							'DESIGN.md': `${INDEX}${marker}[Part](lib/topic.md#part) — x\n`,
							'lib/topic.md': `${TOPIC}\n## Other\n`,
						},
						/lib\/topic\.md section "Other" is not indexed/
					);
			});

			it('indexes a repeated ## heading by its de-duplicated anchor', async function () {
				const repeated = note('## Note');
				await fails({ 'lib/DESIGN.md': repeated }, /section "Note" is not indexed/);
				await passes({ 'DESIGN.md': `${INDEX}- [Note again](lib/DESIGN.md#note-1) — x\n`, 'lib/DESIGN.md': repeated });
			});
		});

		describe('inside the notes', function () {
			it('accepts links to files, anchors at any heading level, the same file, and the web', async function () {
				await passes({
					'DESIGN.md': `## lib/\n\n${INDEX}`,
					'lib/DESIGN.md': note(
						'### Sub heading\n[root](../DESIGN.md#lib) [self](#sub-heading) [sibling](./other.ts) [line](other.ts#L10) [web](https://example.com/x#y) [cdn](//example.com/x#y)'
					),
					'lib/other.ts': 'export {};\n',
				});
			});

			it('rejects a stale anchor, naming the file and line', async function () {
				await fails(
					{ 'lib/DESIGN.md': note('[root](../DESIGN.md#renamed-away)') },
					/lib\/DESIGN\.md:5 links to \.\.\/DESIGN\.md#renamed-away, which no heading there produces/
				);
				await fails(
					{ 'lib/DESIGN.md': note('[self](#nope)') },
					/lib\/DESIGN\.md:5 links to #nope, which no heading there produces/
				);
			});

			it('rejects a link to a missing file, resolved against the directory of the note that carries it', async function () {
				await fails(
					{ 'lib/DESIGN.md': note('[gone](./gone.ts)') },
					/lib\/DESIGN\.md:5 links to missing file \.\/gone\.ts/
				);
				await fails(
					{ 'lib/DESIGN.md': note('[wrong](lib/other.ts)'), 'lib/other.ts': 'export {};\n' },
					/links to missing file lib\/other\.ts/
				);
			});

			it('rejects a link that leaves the repository, and reads a leading slash from the repository root', async function () {
				await fails(
					{ 'lib/DESIGN.md': note('[out](../../outside.md)') },
					/lib\/DESIGN\.md:5 links outside the repository: \.\.\/\.\.\/outside\.md/
				);
				await passes({ 'lib/DESIGN.md': note('[root](/lib/other.ts)'), 'lib/other.ts': 'export {};\n' });
			});

			it('checks a titled link in each of its three forms, and a heading indented up to three spaces', async function () {
				for (const title of ['"the title"', "'t'", '(t)'])
					await fails({ 'lib/DESIGN.md': note(`[gone](./gone.ts ${title})`) }, /links to missing file \.\/gone\.ts/);
				await passes({ 'lib/DESIGN.md': `${NOTE}\n   ### Indented\n\n[ok](#indented "title")\n` });
			});

			it('reads headings and fences in a file with CRLF line endings', async function () {
				const crlf = (text) => text.replaceAll('\n', '\r\n');
				await passes({
					'DESIGN.md': crlf(INDEX),
					'lib/DESIGN.md': crlf(note('```md\n[x](./gone.ts)\n```\n\n[self](#note)')),
				});
			});

			it('checks the notes under test directories and the files an index entry registers', async function () {
				await fails(
					{
						'DESIGN.md': `${INDEX}- [Lanes](unitTests/DESIGN.md#lanes) — x\n`,
						'unitTests/DESIGN.md': '# Unit tests\n\n## Lanes\n\n[gone](./gone.js)\n',
					},
					/unitTests\/DESIGN\.md:5 links to missing file \.\/gone\.js/
				);
				await fails(
					{ ...withTopic, 'lib/topic.md': `${TOPIC}\n[stale](DESIGN.md#nope)\n` },
					/lib\/topic\.md:\d+ links to DESIGN\.md#nope/
				);
			});

			it('ignores links in code spans and fenced blocks, and headings in fenced blocks', async function () {
				await passes({
					'lib/DESIGN.md': note('`[x](./gone.ts)`\n\n```md\n[y](./gone.ts)\n## Fake\n```\n\n~~~\n[z](./gone.ts)\n~~~'),
				});
				await fails(
					{ 'lib/DESIGN.md': note('```md\n### Fake\n```\n\n[into the fence](#fake)') },
					/links to #fake, which no heading there produces/
				);
			});

			it('ignores a link in a nested code span, and a code span that opens a line is not a fence', async function () {
				await passes({ 'lib/DESIGN.md': note('`` `[x](./gone.ts)` ``') });
				await fails(
					{ 'lib/DESIGN.md': note('```inline``` text\n\n## Unindexed') },
					/section "Unindexed" is not indexed/
				);
			});

			it('reports a code fence that is never closed', async function () {
				await fails(
					{ 'lib/DESIGN.md': note('```md\n[x](./gone.ts)') },
					/lib\/DESIGN\.md:5 opens a code fence that is never closed/
				);
			});

			it('de-duplicates heading anchors across levels as GitHub does', async function () {
				const headings = '# a\n\n## Note\n\n### Note\n\n### Note 1\n\n### Note\n';
				await passes({ 'lib/DESIGN.md': `${headings}\n[a](#note-1) [b](#note-1-1) [c](#note-2)\n` });
				await fails({ 'lib/DESIGN.md': `${headings}\n[d](#note-3)\n` }, /links to #note-3/);
			});
		});
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
		const ceiling = 100_000;
		const floor = 60_000;
		const withCeiling = (size, limit, extra = {}) =>
			createTree({ 'lib/DESIGN.md': sized(size), [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': limit }), ...extra });

		it(`lets a file over budget sit anywhere from its ceiling down to ${100 - CEILING_HEADROOM}% of it`, async function () {
			dir = withCeiling(ceiling, ceiling);
			for (const size of [ceiling, ceiling - 1, 70_000, floor]) {
				write(dir, { 'lib/DESIGN.md': sized(size) });
				assert.deepStrictEqual(await errorsOf(), [], `${size} bytes needs no ceiling change`);
			}
		});

		it('fails a file that grows past its ceiling, naming the size a cut must reach', async function () {
			dir = withCeiling(ceiling + 1, ceiling);
			assert.match(
				(await errorsOf()).join('\n'),
				/^lib\/DESIGN\.md is 100,001 bytes, over its ceiling of 100,000 — prune it to at most 60,000 bytes \(60% of the ceiling\), then run `npm run check:design-docs -- --update-ceilings`$/
			);
			write(dir, { 'lib/DESIGN.md': sized(over + 1), [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': over }) });
			assert.match(
				(await errorsOf()).join('\n'),
				/prune it to at most 30,720 bytes \(60% of the ceiling, and within the budget, so the ceiling goes\)/
			);
		});

		it('fails a trim more than 40% under the ceiling until --update-ceilings lowers it, keeping 40% of room', async function () {
			dir = withCeiling(floor - 1, ceiling);
			assert.match(
				(await errorsOf()).join('\n'),
				/^lib\/DESIGN\.md is 59,999 bytes, more than 40% under its ceiling of 100,000; a trim that deep lowers the ceiling — run `npm run check:design-docs -- --update-ceilings`$/
			);
			write(dir, { 'lib/DESIGN.md': sized(50_000) });
			assert.deepStrictEqual(updateCeilings({ root: dir }), { 'lib/DESIGN.md': 83_334 });
			assert.deepStrictEqual(await errorsOf(), []);
		});

		it('--update-ceilings writes the highest ceiling a size fits, never above the old one', function () {
			dir = withCeiling(ceiling + 500, ceiling);
			assert.deepStrictEqual(updateCeilings({ root: dir }), { 'lib/DESIGN.md': ceiling }, 'over its ceiling');
			for (const size of [floor, 70_000, ceiling - 1]) {
				write(dir, { 'lib/DESIGN.md': sized(size), [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': ceiling }) });
				assert.deepStrictEqual(updateCeilings({ root: dir }), { 'lib/DESIGN.md': ceiling }, `${size} is in the band`);
			}
			for (const size of [41_000, 50_001, 50_002, 59_999]) {
				write(dir, { 'lib/DESIGN.md': sized(size), [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': ceiling }) });
				const lowered = updateCeilings({ root: dir })['lib/DESIGN.md'];
				assert.ok(lowered < ceiling, `${size}`);
				assert.ok(Math.floor((lowered * 3) / 5) <= size && Math.floor(((lowered + 1) * 3) / 5) > size, `${size}`);
			}
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

		it('--update-ceilings records a DESIGN.md new to the list at its size and drops the ones within budget', async function () {
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
			await assert.rejects(errorsOf({ base: '--output=x' }), /--base --output=x does not resolve to a commit/);
		});
	});

	describe('a cut a ceiling forces', function () {
		const head = '## Note\n\n';
		const paragraphs = { a: prose('a', 40_000), b: prose('b', 30_000), c: prose('c', 20_000), d: prose('d', 9_000) };
		const base = head + Object.values(paragraphs).join('\n');
		const ceiling = bytesOf(base) + 1_000;
		const floor = Math.floor((ceiling * 3) / 5);
		// Pads `text` with prose to exactly `bytes`.
		const fill = (text, bytes) => text + prose('z', bytes - bytesOf(text));
		let baseRef;
		beforeEach(function () {
			dir = createTree({ 'lib/DESIGN.md': base, [CEILINGS_FILE]: ceilings({ 'lib/DESIGN.md': ceiling }) });
			baseRef = isolatedGit(dir).commit('base');
		});
		const errorsSince = async (options) => (await errorsOf({ base: baseRef, ...options })).join('\n');

		it('fails a change whose new text passes the ceiling and that cuts back only to just under it', async function () {
			const added = prose('e', 2_000);
			write(dir, {
				'lib/DESIGN.md': `${head}${paragraphs.a}\n${paragraphs.b}\n${paragraphs.c}\n${prose('d', 7_500)}\n${added}`,
			});
			const size = bytesOf(readFileSync(join(dir, 'lib/DESIGN.md'), 'utf8'));
			assert.ok(size < ceiling && size > ceiling - 1_000, `${size} sits just under ${ceiling}`);
			assert.deepStrictEqual(await errorsOf(), [], 'without --base only the size is judged');
			const errors = await errorsSince();
			assert.match(
				errors,
				new RegExp(
					`^lib/DESIGN\\.md: this change adds 2,0\\d\\d bytes of new text to a file 1,000 bytes under its ceiling of ${formatted(ceiling)} at ${baseRef}, and cuts it back only to ${formatted(size)}; a change that has to cut to fit cuts to at most ${formatted(floor)} bytes \\(60% of the ceiling\\) — prune ${formatted(size - floor)} more, then run \`npm run check:design-docs -- --update-ceilings\`$`
				)
			);
			assert.strictEqual(errors.split('\n').length, 1, errors);
		});

		it('catches new text added and paid for inside the same paragraph line', async function () {
			write(dir, {
				'lib/DESIGN.md': `${head}${prose('e', 2_000).trimEnd()} ${paragraphs.a.slice(1_500)}\n${paragraphs.b}\n${paragraphs.c}\n${paragraphs.d}`,
			});
			assert.match(await errorsSince(), /adds 2,0\d\d bytes of new text/);
		});

		it('passes the same change once it is cut to the floor, and after --update-ceilings when cut deeper', async function () {
			write(dir, { 'lib/DESIGN.md': fill(`${head}${prose('e', 2_000)}${paragraphs.b}`, floor) });
			assert.strictEqual(await errorsSince(), '');
			write(dir, { 'lib/DESIGN.md': fill(`${head}${prose('e', 2_000)}${paragraphs.b}`, floor - 5_000) });
			assert.match(await errorsSince(), /more than 40% under its ceiling/);
			const lowered = updateCeilings({ root: dir })['lib/DESIGN.md'];
			assert.ok(lowered < ceiling && lowered > floor, `${lowered}`);
			assert.strictEqual(await errorsSince(), '');
		});

		it('passes a cut that takes the file within budget once --update-ceilings drops its ceiling', async function () {
			write(dir, { 'lib/DESIGN.md': `${head}${prose('e', 2_000)}${paragraphs.c}` });
			assert.match(await errorsSince(), /within the [\d,]+-byte budget, so its ceiling is spent/);
			assert.deepStrictEqual(updateCeilings({ root: dir }), {});
			assert.strictEqual(await errorsSince(), '');
		});

		it('passes changes that bring no new text past the room: a cut, a move, an edited move, a re-wrap, CRLF', async function () {
			const variants = {
				'cut': `${head}${paragraphs.a}\n${paragraphs.b}\n${paragraphs.d}`,
				'move': `${head}${paragraphs.d}\n${paragraphs.b}\n${paragraphs.a}\n${paragraphs.c}`,
				'edited move': `${head}${paragraphs.b.replace('b7 ', 'b7, ')}\n${paragraphs.a}\n${paragraphs.c}\n${paragraphs.d.trimEnd()}.\n`,
				're-wrap': `${head}${paragraphs.a.replaceAll(/(a\d*0) /g, '$1\n')}\n${paragraphs.b}\n${paragraphs.c}\n${paragraphs.d}`,
				'one token edited': base.replace(' c10 ', ' c10x '),
				'CRLF': base.replaceAll('\n', '\r\n'),
			};
			for (const [name, text] of Object.entries(variants)) {
				write(dir, { 'lib/DESIGN.md': text });
				assert.strictEqual(await errorsSince(), '', name);
			}
		});

		it('fails a small cut of a file that was already over its ceiling at the base', async function () {
			write(dir, { 'lib/DESIGN.md': `${base}${prose('e', 1_300)}` });
			const red = isolatedGit(dir).commit('a race left it over its ceiling');
			write(dir, { 'lib/DESIGN.md': `${base}${prose('e', 900)}` });
			assert.match(
				(await errorsOf({ base: red })).join('\n'),
				/adds \d+ bytes of new text to a file 300 bytes over its ceiling .* cuts to at most/
			);
		});

		it('skips the rule under --push, and on the command line', async function () {
			write(dir, {
				'lib/DESIGN.md': `${head}${paragraphs.a}\n${paragraphs.b}\n${paragraphs.c}\n${prose('d', 7_500)}\n${prose('e', 2_000)}`,
			});
			assert.strictEqual(await errorsSince({ push: true }), '');
			const run = (...args) =>
				spawnSync(process.execPath, [CLI, '--root', dir, '--base', baseRef, ...args], {
					encoding: 'utf8',
					timeout: DEADLINE,
				});
			assert.match(run().stderr, /^error: lib\/DESIGN\.md: this change adds/m);
			assert.strictEqual(run('--push').status, 0);
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
