#!/usr/bin/env node
// Prints the nested declaration tree of a source file, or of every source file under a directory, with
// line ranges and `// #section:` markers: `npm run outline -- <file|dir>...`. Parse only (no program, no
// type check), so it is a declaration outline, not a binding resolver: imports, inherited members and
// members assigned after construction are not listed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude']);
const SECTION = /^\s*\/\/\s*#section:\s*(\S+)/;

export function* sourceFiles(dir) {
	const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP.has(entry.name)) yield* sourceFiles(full);
		} else if (SOURCE_FILE.test(entry.name)) yield full;
	}
}

export function parse(fileName, text) {
	const extension = path.extname(fileName);
	const kind =
		extension === '.tsx'
			? ts.ScriptKind.TSX
			: extension === '.jsx'
				? ts.ScriptKind.JSX
				: /^\.[cm]?ts$/.test(extension)
					? ts.ScriptKind.TS
					: ts.ScriptKind.JS;
	return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
}

const unwrap = (node) => {
	while (
		node &&
		(ts.isParenthesizedExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isSatisfiesExpression(node) ||
			ts.isTypeAssertionExpression(node))
	)
		node = node.expression;
	return node;
};
const isFunctionLike = (node) => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

// Nodes are `{ kind, name, start, end, children, static? }`; `kind: 'section'` marks a `// #section:` range.
export function outlineSource(fileName, text) {
	const sourceFile = parse(fileName, text);
	const line = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
	const symbol = (kind, name, node, children = []) => ({
		kind,
		name,
		start: line(node.getStart(sourceFile)),
		end: line(node.end),
		children,
	});
	const memberName = (name) => {
		if (!name) return undefined;
		if (ts.isComputedPropertyName(name)) return `[${name.expression.getText(sourceFile)}]`;
		return name.text;
	};
	const bindingNames = (name) =>
		ts.isIdentifier(name)
			? [name]
			: name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));

	const functionBody = (body, context) => (body && ts.isBlock(body) ? statements(body.statements, context) : []);
	const declaresFunctions = (body) =>
		body?.statements?.some(
			(statement) =>
				ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				(ts.isVariableStatement(statement) &&
					statement.declarationList.declarations.some((declaration) => {
						const initializer = unwrap(declaration.initializer);
						return isFunctionLike(initializer) || (initializer && ts.isClassExpression(initializer));
					}))
		);

	function classMembers(members) {
		const result = [];
		members.forEach((member, index) => {
			const name = ts.isConstructorDeclaration(member) ? 'constructor' : memberName(member.name);
			if (name === undefined) return;
			const next = members[index + 1];
			if (
				(ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) &&
				!member.body &&
				next?.kind === member.kind &&
				memberName(next.name) === memberName(member.name)
			)
				return;
			let node;
			if (ts.isConstructorDeclaration(member))
				node = symbol('constructor', name, member, functionBody(member.body, 'body'));
			else if (ts.isMethodDeclaration(member)) node = symbol('method', name, member, functionBody(member.body, 'body'));
			else if (ts.isGetAccessorDeclaration(member)) node = symbol('get', name, member);
			else if (ts.isSetAccessorDeclaration(member)) node = symbol('set', name, member);
			else if (ts.isPropertyDeclaration(member)) node = symbol('property', name, member);
			else return;
			if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) node.static = true;
			result.push(node);
		});
		return result;
	}

	function objectMembers(object) {
		const result = [];
		for (const property of object.properties) {
			const name = memberName(property.name);
			if (name === undefined) continue;
			if (ts.isMethodDeclaration(property)) result.push(symbol('method', name, property));
			else if (ts.isGetAccessorDeclaration(property)) result.push(symbol('get', name, property));
			else if (ts.isSetAccessorDeclaration(property)) result.push(symbol('set', name, property));
			else if (ts.isShorthandPropertyAssignment(property)) result.push(symbol('property', name, property));
			else if (ts.isPropertyAssignment(property)) {
				const value = unwrap(property.initializer);
				if (isFunctionLike(value)) result.push(symbol('method', name, property));
				else if (ts.isObjectLiteralExpression(value))
					result.push(symbol('property', name, property, objectMembers(value)));
				else result.push(symbol('property', name, property));
			}
		}
		return result;
	}

	// `context` is 'module', 'factory' (a module-level function that declares functions or classes, such as
	// `makeTable()`: all of its top-level declarations are listed) or 'body' (any other function body: only
	// nested functions and classes are listed).
	function statements(list, context) {
		const result = [];
		list.forEach((statement, index) => {
			if (ts.isFunctionDeclaration(statement) && statement.name) {
				const next = list[index + 1];
				if (!statement.body && next && ts.isFunctionDeclaration(next) && next.name?.text === statement.name.text)
					return;
				const bodyContext = context === 'module' && declaresFunctions(statement.body) ? 'factory' : 'body';
				result.push(symbol('function', statement.name.text, statement, functionBody(statement.body, bodyContext)));
			} else if (ts.isClassDeclaration(statement) && statement.name) {
				result.push(symbol('class', statement.name.text, statement, classMembers(statement.members)));
			} else if (context === 'body') {
				if (ts.isVariableStatement(statement)) result.push(...variables(statement, context));
			} else if (ts.isVariableStatement(statement)) {
				result.push(...variables(statement, context));
			} else if (ts.isInterfaceDeclaration(statement)) {
				result.push(symbol('interface', statement.name.text, statement));
			} else if (ts.isTypeAliasDeclaration(statement)) {
				result.push(symbol('type', statement.name.text, statement));
			} else if (ts.isEnumDeclaration(statement)) {
				const members = statement.members.map((member) => symbol('member', memberName(member.name), member));
				result.push(symbol('enum', statement.name.text, statement, members));
			} else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
				const body =
					statement.body && ts.isModuleBlock(statement.body) ? statements(statement.body.statements, context) : [];
				result.push(symbol('namespace', statement.name.text, statement, body));
			} else if (
				ts.isExportDeclaration(statement) &&
				statement.exportClause &&
				ts.isNamedExports(statement.exportClause)
			) {
				for (const specifier of statement.exportClause.elements)
					result.push(symbol('export', specifier.name.text, specifier));
			}
		});
		return result;
	}

	function variables(statement, context) {
		const result = [];
		for (const declaration of statement.declarationList.declarations) {
			const initializer = unwrap(declaration.initializer);
			if (ts.isIdentifier(declaration.name) && isFunctionLike(initializer)) {
				const bodyContext =
					context === 'module' && ts.isBlock(initializer.body) && declaresFunctions(initializer.body)
						? 'factory'
						: 'body';
				result.push(
					symbol('function', declaration.name.text, declaration, functionBody(initializer.body, bodyContext))
				);
			} else if (ts.isIdentifier(declaration.name) && initializer && ts.isClassExpression(initializer)) {
				result.push(symbol('class', declaration.name.text, declaration, classMembers(initializer.members)));
			} else if (context !== 'body') {
				const children =
					ts.isIdentifier(declaration.name) && initializer && ts.isObjectLiteralExpression(initializer)
						? objectMembers(initializer)
						: [];
				for (const name of bindingNames(declaration.name))
					result.push(symbol('variable', name.text, name === declaration.name ? declaration : name, children));
			}
		}
		return result;
	}

	const lines = text.split('\n');
	const tree = {
		kind: 'file',
		name: fileName,
		start: 1,
		end: lines.length,
		children: statements(sourceFile.statements, 'module'),
	};
	const markers = [];
	lines.forEach((text, i) => {
		const match = SECTION.exec(text);
		if (match) markers.push({ name: match[1], line: i + 1 });
	});
	markers.forEach((marker, i) => {
		let container = tree;
		for (let inner = container; inner;) {
			container = inner;
			inner = container.children.find(
				(child) => child.kind !== 'section' && child.start <= marker.line && marker.line <= child.end
			);
		}
		const nextLine = markers[i + 1]?.line ?? Infinity;
		const section = {
			kind: 'section',
			name: marker.name,
			start: marker.line,
			end: Math.min(nextLine - 1, container.end),
			children: [],
		};
		const at = container.children.findIndex((child) => child.start > marker.line);
		container.children.splice(at === -1 ? container.children.length : at, 0, section);
	});
	return tree;
}

export function formatOutline(tree, depth = 0) {
	const out = [];
	for (const node of tree.children) {
		const range = node.start === node.end ? `${node.start}` : `${node.start}-${node.end}`;
		const label =
			node.kind === 'section' ? `#section: ${node.name}` : `${node.static ? 'static ' : ''}${node.kind} ${node.name}`;
		out.push(`${'  '.repeat(depth + 1)}${label}  ${range}`);
		out.push(...formatOutline(node, depth + 1));
	}
	return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const targets = process.argv.slice(2);
	if (targets.length === 0) {
		console.error('usage: npm run outline -- <file|dir>...');
		process.exit(2);
	}
	for (const target of targets) {
		if (!fs.existsSync(target)) {
			console.error(`outline: no such file or directory: ${target}`);
			process.exit(1);
		}
		const files = fs.statSync(target).isDirectory() ? [...sourceFiles(target)] : [target];
		for (const file of files) {
			console.log(path.relative(process.cwd(), file) || file);
			for (const line of formatOutline(outlineSource(file, fs.readFileSync(file, 'utf8')))) console.log(line);
		}
	}
}
