import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../..');
const sourceDirectories = [
	'agent',
	'bin',
	'components',
	'config',
	'dataLayer',
	'resources',
	'security',
	'server',
	'sqlEngine',
	'sqlTranslator',
	'utility',
	'validation',
];

function hasLocalRequire(call) {
	for (let scope = call.parent; scope; scope = scope.parent) {
		if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
		for (const statement of scope.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === 'require' &&
					declaration.initializer &&
					ts.isCallExpression(declaration.initializer) &&
					ts.isIdentifier(declaration.initializer.expression) &&
					declaration.initializer.expression.text === 'createRequire'
				)
					return true;
			}
		}
	}
	return false;
}

describe('TypeStrip source imports', () => {
	it('avoids imports of renamed JavaScript files and bare require calls', () => {
		const unbound = [];
		const missingSourceImports = [];
		for (const directory of sourceDirectories) {
			const parent = join(root, directory);
			for (const file of readdirSync(parent, { recursive: true })) {
				if (!file.endsWith('.ts')) continue;
				const absolute = join(parent, file);
				const source = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
				const visit = (node) => {
					if (
						ts.isCallExpression(node) &&
						ts.isIdentifier(node.expression) &&
						node.expression.text === 'require' &&
						!hasLocalRequire(node)
					) {
						const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
						unbound.push(`${relative(root, absolute)}:${line + 1}`);
					}
					const specifier =
						(ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
						(ts.isExportDeclaration(node) && !node.isTypeOnly)
							? node.moduleSpecifier
							: ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
								? node.arguments[0]
								: undefined;
					if (
						specifier &&
						ts.isStringLiteralLike(specifier) &&
						specifier.text.startsWith('.') &&
						specifier.text.endsWith('.js')
					) {
						const target = resolve(dirname(absolute), specifier.text);
						if (!existsSync(target) && existsSync(target.slice(0, -3) + '.ts')) {
							const { line } = source.getLineAndCharacterOfPosition(specifier.getStart(source));
							missingSourceImports.push(`${relative(root, absolute)}:${line + 1} (${specifier.text})`);
						}
					}
					ts.forEachChild(node, visit);
				};
				visit(source);
			}
		}
		assert.deepStrictEqual(
			missingSourceImports,
			[],
			`Source imports target renamed JavaScript files: ${missingSourceImports.join(', ')}`
		);
		assert.deepStrictEqual(unbound, [], `Bare require calls fail in native ESM: ${unbound.join(', ')}`);
	});
});
