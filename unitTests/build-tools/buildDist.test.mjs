import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build, escapeNonLatin1Literals, findNonLatin1 } from '../../build-tools/build-dist.mjs';

const NON_LATIN1 = /[\u0100-\uffff]/;

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

	it('builds the project of the tsconfig it is given', async function () {
		this.timeout(30000);
		const directory = await mkdtemp(join(tmpdir(), 'build-dist-'));
		try {
			await mkdir(join(directory, 'src'));
			await writeFile(
				join(directory, 'src', 'index.ts'),
				`/** Says — hi. */\nexport const greeting: string = 'hi → there'; // trailing\n`
			);
			await writeFile(
				join(directory, 'tsconfig.custom.json'),
				JSON.stringify({
					include: ['src/**/*'],
					compilerOptions: { outDir: 'out', declaration: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
				})
			);
			assert.strictEqual(build(join(directory, 'tsconfig.custom.json')), 0);
			const js = await readFile(join(directory, 'out', 'index.js'), 'utf8');
			assert.doesNotMatch(js, /\/\*\*|\/\/ trailing/);
			assert.doesNotMatch(js, NON_LATIN1);
			assert.match(await readFile(join(directory, 'out', 'index.d.ts'), 'utf8'), /\/\*\* Says — hi\. \*\//);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

it('builds native telemetry declarations without the optional fulltext package', function () {
	this.timeout(30_000);
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const configPath = join(root, 'tsconfig.build.json');
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
	const optionalImports = config.fileNames.flatMap((file) =>
		ts
			.preProcessFile(ts.sys.readFile(file), true, true)
			.importedFiles.filter(
				({ fileName }) => fileName === '@harperfast/fulltext' || fileName.startsWith('@harperfast/fulltext/')
			)
			.map(({ fileName }) => `${file}: ${fileName}`)
	);
	assert.deepStrictEqual(optionalImports, []);
	const options = { ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true };
	const host = ts.createCompilerHost(options);
	const optionalPackage = /[/\\]node_modules[/\\]@harperfast[/\\]fulltext(?:[/\\]|$)/;
	for (const method of ['fileExists', 'directoryExists', 'readFile']) {
		const original = host[method].bind(host);
		host[method] = (file) =>
			optionalPackage.test(file) ? (method === 'readFile' ? undefined : false) : original(file);
	}
	const files = ['resources/indexes/fullTextNativeBinding.ts', 'resources/analytics/fullTextTelemetry.ts'].map((file) =>
		join(root, file)
	);
	const program = ts.createProgram(files, options, host);
	for (const file of files) {
		const source = program.getSourceFile(file);
		assert.deepStrictEqual(
			program
				.getSemanticDiagnostics(source)
				.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
			[]
		);
		const declarations = [];
		const emitted = program.emit(
			source,
			(name, text) => {
				if (name.endsWith('.d.ts')) declarations.push(text);
			},
			undefined,
			true
		);
		assert.strictEqual(emitted.emitSkipped, false);
		assert.strictEqual(declarations.length, 1);
		assert.doesNotMatch(declarations[0], /@harperfast\/fulltext/);
	}
});
