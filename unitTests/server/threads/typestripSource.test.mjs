import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
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
	it('uses an explicit runtime loader for production require calls', () => {
		const unbound = [];
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
					ts.forEachChild(node, visit);
				};
				visit(source);
			}
		}
		assert.deepStrictEqual(unbound, [], `Bare require calls fail in native ESM: ${unbound.join(', ')}`);
	});
});
