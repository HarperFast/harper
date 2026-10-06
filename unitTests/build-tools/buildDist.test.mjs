import assert from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { escapeNonLatin1Literals, findNonLatin1 } from '../../build-tools/build-dist.mjs';

const NON_LATIN1 = /[^\x00-\xff]/;

function compile(source, transform = true) {
	return ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true },
		fileName: 'fixture.ts',
		transformers: transform ? { after: [escapeNonLatin1Literals] } : undefined,
	});
}

function evaluate(js) {
	const module = { exports: {} };
	new Function('module', 'exports', js)(module, module.exports);
	return module.exports;
}

describe('build-dist non-Latin-1 literal escaping', function () {
	const source = [
		`export const plain = 'em — dash';`,
		`export const doubleQuoted = "arrow → right";`,
		`export const astral = '📦 package';`,
		`export const identityEscape = '\\—';`,
		`export const literalBackslash = '\\\\—';`,
		`export const latin1 = 'café';`,
		'export const noSubstitution = `check ✓`;',
		'const count = 3;',
		'export const substituted = `${count} → ${count + 1} — done ✓`;',
		'export const nested = `outer — ${`inner → ${count}`} ✓`;',
		`export const keyed = { 'clé—x': 1 }['clé—x'];`,
	].join('\n');

	it('emits Latin-1 JS that evaluates to the same values', function () {
		const escaped = compile(source).outputText;
		assert.doesNotMatch(escaped, NON_LATIN1);
		assert.deepStrictEqual(evaluate(escaped), evaluate(compile(source, false).outputText));
	});

	it('is idempotent', function () {
		const once = compile(source).outputText;
		assert.strictEqual(compile(once).outputText, once);
	});

	it('leaves the text of tagged templates alone because the tag can read .raw', function () {
		const escaped = compile('export const raw = String.raw`a — b`;').outputText;
		assert.match(escaped, /a — b/);
		assert.strictEqual(evaluate(escaped).raw, 'a — b');
	});

	it('escapes literals inside the tag and substitutions of a tagged template', function () {
		const source = "const tags = { '→': String.raw }; export const raw = tags['→']`a ${'—'} b ${`→ ${1}`}`;";
		const escaped = compile(source).outputText;
		assert.doesNotMatch(escaped, NON_LATIN1);
		assert.strictEqual(evaluate(escaped).raw, 'a — b → 1');
	});

	it('keeps source-map positions for code after an escaped literal on the same line', function () {
		const line = `const label = '— → ✓'; export function fail() { throw new Error(label); }`;
		const { outputText, sourceMapText } = compile(line);
		const generatedLine = outputText.split('\n').findIndex((text) => text.includes('throw new Error'));
		const generatedColumn = outputText.split('\n')[generatedLine].indexOf('throw new Error');
		const entry = new SourceMap(JSON.parse(sourceMapText)).findEntry(generatedLine, generatedColumn);
		assert.strictEqual(entry.originalLine, 0);
		assert.strictEqual(entry.originalColumn, line.indexOf('throw new Error'));
	});

	it('reports file and line of any non-Latin-1 text left in emitted JS', async function () {
		const directory = await mkdtemp(join(tmpdir(), 'build-dist-'));
		try {
			await mkdir(join(directory, 'nested'));
			await writeFile(join(directory, 'clean.js'), `'use strict';\nconst a = '\\u2014';\n`);
			await writeFile(join(directory, 'nested', 'dirty.js'), `'use strict';\nconst a = String.raw\`—\`;\n`);
			await writeFile(join(directory, 'nested', 'ignored.d.ts'), `/** — */\n`);
			assert.deepStrictEqual(findNonLatin1(directory), [join(directory, 'nested', 'dirty.js') + ':2']);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
