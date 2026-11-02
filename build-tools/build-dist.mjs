#!/usr/bin/env node
// Production emit of dist/; why it strips comments and escapes non-Latin-1 text: build-tools/DESIGN.md.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const NON_LATIN1 = /[\u0100-\uffff]/;

// Synthesized literal nodes are printed escaped; ones parsed from source are copied verbatim.
export function escapeNonLatin1Literals(context) {
	const { factory } = context;
	const replace = (node, created) => ts.setSourceMapRange(ts.setOriginalNode(created, node), node);
	const visit = (node) => {
		// a tag can read `.raw`, so only its text stays as written (the final Latin-1 check reports it)
		if (ts.isTaggedTemplateExpression(node)) {
			const { template } = node;
			return factory.updateTaggedTemplateExpression(
				node,
				ts.visitNode(node.tag, visit),
				node.typeArguments,
				ts.isTemplateExpression(template)
					? factory.updateTemplateExpression(
							template,
							template.head,
							template.templateSpans.map((span) =>
								factory.updateTemplateSpan(span, ts.visitNode(span.expression, visit), span.literal)
							)
						)
					: template
			);
		}
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

function readConfig(configPath) {
	return ts.getParsedCommandLineOfConfigFile(
		configPath,
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

export function build(configPath) {
	const config = readConfig(configPath);
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

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: { project: { type: 'string', short: 'p', default: 'tsconfig.build.json' } },
	});
	process.exitCode = build(values.project);
}
