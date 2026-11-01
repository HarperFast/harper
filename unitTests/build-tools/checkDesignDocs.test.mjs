import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../../build-tools/check-design-docs.mjs');

const ROOT = `Index of design notes.

## a/

- [Topic one](a/DESIGN.md#topic-one) — x
`;
const NOTE = `# a

Index: [DESIGN.md](../DESIGN.md).

## Topic one

Body.
`;

const padded = (content, count) => {
	const missing = count - content.split('\n').length;
	return missing > 0 ? `${content}${'\nfiller'.repeat(missing)}` : content;
};

describe('check-design-docs', function () {
	this.timeout(60_000);
	const workDirs = [];

	afterEach(function () {
		for (const workDir of workDirs.splice(0)) rmSync(workDir, { recursive: true, force: true });
	});

	// The script finds its repository from its own location, so each case runs a copy inside a fixture.
	function check(files) {
		const workDir = mkdtempSync(join(tmpdir(), 'check-design-docs-'));
		workDirs.push(workDir);
		const all = { 'DESIGN.md': ROOT, 'a/DESIGN.md': NOTE, ...files };
		for (const [name, content] of Object.entries(all)) {
			mkdirSync(dirname(join(workDir, name)), { recursive: true });
			writeFileSync(join(workDir, name), content);
		}
		mkdirSync(join(workDir, 'build-tools'), { recursive: true });
		copyFileSync(SCRIPT, join(workDir, 'build-tools/check-design-docs.mjs'));
		const result = spawnSync(process.execPath, [join(workDir, 'build-tools/check-design-docs.mjs')], {
			encoding: 'utf8',
			timeout: 30_000,
		});
		assert.ifError(result.error);
		return result;
	}
	const passes = (files) => {
		const result = check(files);
		assert.strictEqual(result.status, 0, result.stderr);
	};
	const fails = (files, message) => {
		const result = check(files);
		assert.strictEqual(result.status, 1, result.stdout);
		assert.match(result.stderr, message);
	};
	const note = (extra) => `${NOTE}\n${extra}\n`;

	it('accepts a complete index', function () {
		passes({});
	});

	describe('line budgets', function () {
		it('rejects a root index over 250 lines and accepts exactly 250', function () {
			passes({ 'DESIGN.md': padded(ROOT, 250) });
			fails({ 'DESIGN.md': padded(ROOT, 251) }, /DESIGN\.md is 251 lines; the index budget is 250/);
		});

		it('rejects a per-directory DESIGN.md over 1000 lines and accepts exactly 1000', function () {
			passes({ 'a/DESIGN.md': padded(NOTE, 1000) });
			fails({ 'a/DESIGN.md': padded(NOTE, 1001) }, /a\/DESIGN\.md is 1001 lines; the budget is 1000/);
		});

		it('budgets a DESIGN.md the index registers inside a directory the walk skips', function () {
			const indexed = ROOT + '\n## unitTests/\n\n- [Lanes](unitTests/DESIGN.md#lanes) — x\n';
			const skipped = '# Unit tests\n\n## Lanes\n\nBody.\n';
			passes({ 'DESIGN.md': indexed, 'unitTests/DESIGN.md': skipped });
			fails(
				{ 'DESIGN.md': indexed, 'unitTests/DESIGN.md': padded(skipped, 1001) },
				/unitTests\/DESIGN\.md is 1001 lines; the budget is 1000/
			);
		});
	});

	describe('index completeness', function () {
		it('rejects a section missing from the index', function () {
			fails({ 'a/DESIGN.md': note('## Topic two') }, /a\/DESIGN\.md section "Topic two" is not indexed in DESIGN\.md/);
		});

		it('rejects a root link to a missing file and to a heading that is not ##', function () {
			fails({ 'DESIGN.md': `${ROOT}- [Gone](a/gone.md#x) — x\n` }, /DESIGN\.md:\d+ links to missing file a\/gone\.md/);
			fails(
				{ 'DESIGN.md': `${ROOT}- [Sub](a/DESIGN.md#sub) — x\n`, 'a/DESIGN.md': note('### Sub') },
				/DESIGN\.md:\d+ links to a\/DESIGN\.md#sub, which no ## heading there produces/
			);
		});

		it('requires every ## section of a note the index registers by a non-DESIGN.md target', function () {
			const registered = `${ROOT}\n## a/topic.md\n\n- [Part](a/topic.md#part) — x\n`;
			passes({ 'DESIGN.md': registered, 'a/topic.md': '# Topic\n\n## Part\n\nBody.\n' });
			fails(
				{ 'DESIGN.md': registered, 'a/topic.md': '# Topic\n\n## Part\n\n## Other\n' },
				/a\/topic\.md section "Other" is not indexed in DESIGN\.md/
			);
		});
	});

	describe('links inside design notes', function () {
		it('accepts links to files, anchors at any heading level, and the same file', function () {
			passes({
				'a/DESIGN.md': note(
					[
						'### Sub heading',
						'[root](../DESIGN.md#a) [self](#sub-heading) [sibling](./other.ts) [line](other.ts#L10) [web](https://example.com/x#y)',
					].join('\n')
				),
				'a/other.ts': 'export {};\n',
			});
		});

		it('rejects a stale anchor, naming the file and line', function () {
			fails(
				{ 'a/DESIGN.md': note('[root](../DESIGN.md#renamed-away)') },
				/a\/DESIGN\.md:\d+ links to \.\.\/DESIGN\.md#renamed-away, which no heading there produces/
			);
			fails(
				{ 'a/DESIGN.md': note('[self](#nope)') },
				/a\/DESIGN\.md:\d+ links to #nope, which no heading there produces/
			);
		});

		it('checks a titled link, and a heading indented up to three spaces', function () {
			for (const title of ['"the title"', "'t'", '(t)'])
				fails({ 'a/DESIGN.md': note(`[gone](./gone.ts ${title})`) }, /links to missing file \.\/gone\.ts/);
			passes({ 'a/DESIGN.md': `${NOTE}\n   ### Indented\n\n[ok](#indented \"title\")\n` });
		});

		it('reads headings and fences in a file with CRLF line endings', function () {
			const crlf = (text) => text.replaceAll('\n', '\r\n');
			passes({
				'DESIGN.md': crlf(ROOT),
				'a/DESIGN.md': crlf(note('```md\n[x](./gone.ts)\n```\n\n[self](#topic-one)')),
			});
		});

		it('rejects a link that leaves the repository, and reads a leading slash from the repository root', function () {
			fails(
				{ 'a/DESIGN.md': note('[out](../../outside.md)') },
				/a\/DESIGN\.md:\d+ links outside the repository: \.\.\/\.\.\/outside\.md/
			);
			passes({ 'a/DESIGN.md': note('[root](/a/other.ts)'), 'a/other.ts': 'export {};\n' });
		});

		it('rejects a link to a missing file', function () {
			fails({ 'a/DESIGN.md': note('[gone](./gone.ts)') }, /a\/DESIGN\.md:\d+ links to missing file \.\/gone\.ts/);
		});

		it('resolves links against the directory of the note that carries them', function () {
			fails(
				{ 'a/DESIGN.md': note('[wrong](a/other.ts)'), 'a/other.ts': 'export {};\n' },
				/links to missing file a\/other\.ts/
			);
		});

		it('validates links inside notes the walk skips and notes registered by a topic file', function () {
			const indexed = ROOT + '\n## unitTests/\n\n- [Lanes](unitTests/DESIGN.md#lanes) — x\n';
			fails(
				{ 'DESIGN.md': indexed, 'unitTests/DESIGN.md': '# Unit tests\n\n## Lanes\n\n[gone](./gone.js)\n' },
				/unitTests\/DESIGN\.md:\d+ links to missing file \.\/gone\.js/
			);
			const registered = `${ROOT}\n## a/topic.md\n\n- [Part](a/topic.md#part) — x\n`;
			fails(
				{ 'DESIGN.md': registered, 'a/topic.md': '# Topic\n\n## Part\n\n[stale](DESIGN.md#nope)\n' },
				/a\/topic\.md:\d+ links to DESIGN\.md#nope/
			);
		});

		it('ignores links in code spans and fenced blocks, and headings in fenced blocks', function () {
			passes({
				'a/DESIGN.md': note('`[x](./gone.ts)`\n\n```md\n[y](./gone.ts)\n## Fake\n```\n\n~~~\n[z](./gone.ts)\n~~~'),
			});
			fails(
				{ 'a/DESIGN.md': note('```md\n### Fake\n```\n\n[into the fence](#fake)') },
				/a\/DESIGN\.md:\d+ links to #fake, which no heading there produces/
			);
		});

		it('ignores a link in a nested code span, and a code span that opens a line is not a fence', function () {
			passes({ 'a/DESIGN.md': note('`` `[x](./gone.ts)` ``') });
			fails({ 'a/DESIGN.md': note('```inline``` text\n\n## Unindexed') }, /section "Unindexed" is not indexed/);
		});

		it('reports a code fence that is never closed', function () {
			fails(
				{ 'a/DESIGN.md': note('```md\n[x](./gone.ts)') },
				/a\/DESIGN\.md:\d+ opens a code fence that is never closed/
			);
		});

		it('de-duplicates heading anchors across levels as GitHub does', function () {
			const headings = '# a\n\n## Topic one\n\n### Topic one\n\n### Topic one 1\n\n### Topic one\n';
			passes({
				'a/DESIGN.md': `${headings}\n[a](#topic-one-1) [b](#topic-one-1-1) [c](#topic-one-2)\n`,
			});
			fails({ 'a/DESIGN.md': `${headings}\n[d](#topic-one-3)\n` }, /links to #topic-one-3/);
		});

		it('indexes the de-duplicated anchor of a repeated ## heading', function () {
			const repeated = note('## Topic one');
			fails({ 'a/DESIGN.md': repeated }, /section "Topic one" is not indexed/);
			passes({
				'DESIGN.md': `${ROOT}- [Topic one again](a/DESIGN.md#topic-one-1) — x\n`,
				'a/DESIGN.md': repeated,
			});
		});
	});

	describe('documents the index only mentions', function () {
		it('links in the prose are checked, but the document gets no budget or section rule', function () {
			const referenced = '# Guide\n\n## Unindexed section\n';
			passes({ 'DESIGN.md': `See [the guide](GUIDE.md).\n${ROOT}`, 'GUIDE.md': padded(referenced, 1500) });
			fails({ 'DESIGN.md': `See [the guide](GONE.md).\n${ROOT}` }, /DESIGN\.md:1 links to missing file GONE\.md/);
		});

		it('lets the prose link to any heading level, and a summary link in an entry still registers its target', function () {
			passes({ 'DESIGN.md': `See [the guide](GUIDE.md#guide).\n${ROOT}`, 'GUIDE.md': '# Guide\n' });
			fails(
				{ 'DESIGN.md': `${ROOT.trimEnd()} — see [the guide](GUIDE.md)\n`, 'GUIDE.md': '# Guide\n\n## Part\n' },
				/GUIDE\.md section "Part" is not indexed/
			);
		});
	});
});
