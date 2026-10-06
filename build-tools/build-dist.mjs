#!/usr/bin/env node
// Production emit of dist/. V8 keeps every loaded module's source text on each thread's heap, and
// stores a whole file as UTF-16 when it holds one char above 0xFF, so the JS is emitted without
// comments and with every non-Latin-1 literal escaped. Declarations are emitted in a second pass so
// they keep their JSDoc.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NON_LATIN1 = /[^\x00-\xff]/;
const CONFIG_PATH = 'tsconfig.build.json';

/**
 * Re-creates string and untagged template literals that contain non-Latin-1 text as synthesized
 * nodes, which the printer escapes instead of copying the original source text.
 */
export function escapeNonLatin1Literals(context) {
	const { factory } = context;
	const replace = (node, created) => ts.setSourceMapRange(ts.setOriginalNode(created, node), node);
	const visit = (node) => {
		// a tag can read `.raw`, so its text is left alone and the final Latin-1 check reports it
		if (ts.isTaggedTemplateExpression(node)) return node;
		if (NON_LATIN1.test(node.text ?? '')) {
			switch (node.kind) {
				case ts.SyntaxKind.StringLiteral:
					return replace(node, factory.createStringLiteral(node.text));
				case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
					return replace(node, factory.createNoSubstitutionTemplateLiteral(node.text));
				case ts.SyntaxKind.TemplateHead:
					return replace(node, factory.createTemplateHead(node.text));
				case ts.SyntaxKind.TemplateMiddle:
					return replace(node, factory.createTemplateMiddle(node.text));
				case ts.SyntaxKind.TemplateTail:
					return replace(node, factory.createTemplateTail(node.text));
			}
		}
		return ts.visitEachChild(node, visit, context);
	};
	return (sourceFile) => ts.visitNode(sourceFile, visit);
}

function readConfig() {
	return ts.getParsedCommandLineOfConfigFile(
		CONFIG_PATH,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
			},
		}
	);
}

function reportDiagnostics(diagnostics) {
	if (diagnostics.length === 0) return false;
	process.stderr.write(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (fileName) => fileName,
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			getNewLine: () => ts.sys.newLine,
		})
	);
	return diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function* emittedScripts(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* emittedScripts(path);
		else if (entry.name.endsWith('.js')) yield path;
	}
}

/** Lists `file:line` for every non-Latin-1 char left in emitted JS. */
export function findNonLatin1(directory) {
	const found = [];
	for (const path of emittedScripts(directory)) {
		const lines = readFileSync(path, 'utf8').split('\n');
		lines.forEach((line, index) => {
			if (NON_LATIN1.test(line)) found.push(`${path}:${index + 1}`);
		});
	}
	return found;
}

function build() {
	const config = readConfig();
	if (reportDiagnostics(config.errors)) return 1;
	const { fileNames, projectReferences } = config;

	const scriptProgram = ts.createProgram({
		rootNames: fileNames,
		options: { ...config.options, removeComments: true, declaration: false, declarationMap: false },
		projectReferences,
	});
	const scriptEmit = scriptProgram.emit(undefined, undefined, undefined, false, {
		after: [escapeNonLatin1Literals],
	});
	let failed = reportDiagnostics([...ts.getPreEmitDiagnostics(scriptProgram), ...scriptEmit.diagnostics]);

	if (config.options.declaration) {
		const declarationProgram = ts.createProgram({
			rootNames: fileNames,
			options: { ...config.options, emitDeclarationOnly: true },
			projectReferences,
			oldProgram: scriptProgram,
		});
		failed = reportDiagnostics(declarationProgram.emit().diagnostics) || failed;
	}

	const leftover = findNonLatin1(config.options.outDir);
	if (leftover.length > 0) {
		process.stderr.write(
			`Emitted JS must be Latin-1 so V8 stores module source one byte per char; non-Latin-1 text remains at:\n  ${leftover.join('\n  ')}\n`
		);
		failed = true;
	}
	return failed ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = build();
