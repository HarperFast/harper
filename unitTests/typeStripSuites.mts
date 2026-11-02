import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';

const unitRoot = resolve(import.meta.dirname);
const distRoot = resolve(unitRoot, '../dist') + sep;

function needsCompiled(file: string, seen = new Set<string>()): boolean {
	file = resolve(file);
	if (seen.has(file)) return false;
	seen.add(file);
	const source = readFileSync(file, 'utf8');
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const localRequire = createRequire(file);
	let compiled = false;
	const dependencies: string[] = [];
	function dependency(specifier: string) {
		if (specifier.startsWith(distRoot)) compiled = true;
		try {
			const target = localRequire.resolve(specifier);
			const path = relative(unitRoot, target);
			if (!path.startsWith('..' + sep) && /\.(?:[cm]?js|[cm]?ts)$/.test(target)) dependencies.push(target);
		} catch {}
	}
	function visit(node: ts.Node) {
		if (ts.isStringLiteralLike(node) && node.text.includes('#js/')) compiled = true;
		if (
			(ts.isDeleteExpression(node) && node.expression.getText(parsed).startsWith('require.cache')) ||
			(ts.isBinaryExpression(node) &&
				node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
				node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
				node.left.getText(parsed).startsWith('require.cache'))
		)
			compiled = true;
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(parsed) === 'require' &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0]) &&
			['@harperfast/rocksdb-js', 'msgpackr'].includes(node.arguments[0].text)
		)
			compiled = true;
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier) &&
			node.moduleSpecifier.text.startsWith('.')
		)
			dependency(node.moduleSpecifier.text);
		if (
			ts.isCallExpression(node) &&
			['join', 'resolve'].includes(
				ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(parsed)
			) &&
			['__dirname', 'import.meta.dirname'].includes(node.arguments[0]?.getText(parsed)) &&
			node.arguments.slice(1).every(ts.isStringLiteralLike)
		) {
			const parts = node.arguments.slice(1) as ts.StringLiteralLike[];
			dependency(resolve(file, '..', ...parts.map((part) => part.text)));
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'require' &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0]) &&
			node.arguments[0].text.startsWith('.')
		) {
			dependency(node.arguments[0].text);
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(parsed) === 'require.resolve' &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0]) &&
			node.arguments[0].text.startsWith('.')
		) {
			dependency(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	}
	visit(parsed);
	return compiled || dependencies.some((dependency) => needsCompiled(dependency, seen));
}

export function partitionSuites(files: string[]) {
	const source: string[] = [];
	const compiled: string[] = [];
	for (const file of [...new Set(files)]) (needsCompiled(file) ? compiled : source).push(file);
	return { source, compiled };
}
