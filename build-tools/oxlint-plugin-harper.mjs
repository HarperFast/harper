const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

function staticPropertyName(member) {
	if (!member.computed) return member.property.name;
	if (member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
}

function keyName(key) {
	return key.type === 'Identifier' ? key.name : key.value;
}

// 'module' marks a callable truthiness assertion that also carries `.ok`: the module object itself,
// and its `default` and `strict` exports.
function exportOrModule(name) {
	return name === 'default' || name === 'strict' ? 'module' : name;
}

function unwrap(node) {
	while (TS_WRAPPERS.has(node.type)) node = node.expression;
	return node;
}

// Which assert-module value an expression evaluates to: 'module', an export name such as 'ok', or
// undefined when it is not one. Identifiers resolve through scope, so shadowing is respected.
function assertValueOf(context, node) {
	node = unwrap(node);
	if (node.type === 'Identifier') return assertBindingOf(context, node);
	if (node.type === 'MemberExpression') {
		const name = staticPropertyName(node);
		return name !== undefined && assertValueOf(context, node.object) === 'module' ? exportOrModule(name) : undefined;
	}
	if (node.type === 'CallExpression') {
		const [specifier] = node.arguments;
		const isRequire = node.callee.type === 'Identifier' && node.callee.name === 'require';
		return isRequire && specifier?.type === 'Literal' && ASSERT_MODULES.has(specifier.value) ? 'module' : undefined;
	}
}

function assertBindingOf(context, identifier) {
	for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
		const variable = scope.set.get(identifier.name);
		if (!variable) continue;
		const definition = variable.defs[0];
		if (definition?.type === 'ImportBinding') {
			if (!ASSERT_MODULES.has(definition.parent.source.value)) return;
			const specifier = definition.node;
			return specifier.type === 'ImportSpecifier' ? exportOrModule(keyName(specifier.imported)) : 'module';
		}
		if (definition?.type !== 'Variable') return;
		const { id, init } = definition.node;
		if (!init) return;
		if (id.type === 'Identifier') return assertValueOf(context, init);
		if (id.type !== 'ObjectPattern' || assertValueOf(context, init) !== 'module') return;
		const property = id.properties.find((candidate) => {
			const value = candidate.value?.type === 'AssignmentPattern' ? candidate.value.left : candidate.value;
			return candidate.type === 'Property' && value?.type === 'Identifier' && value.name === identifier.name;
		});
		return property && !property.computed ? exportOrModule(keyName(property.key)) : undefined;
	}
}

function isTruthinessAssertion(context, callee) {
	const value = assertValueOf(context, callee);
	if (value === 'module' || value === 'ok') return true;
	// node:test's TestContext exposes the assert methods as `t.assert`.
	return (
		callee.type === 'MemberExpression' &&
		staticPropertyName(callee) === 'ok' &&
		callee.object.type === 'MemberExpression' &&
		staticPropertyName(callee.object) === 'assert'
	);
}

const noLiteralTrueAssertion = {
	meta: {
		type: 'problem',
		docs: { description: 'Disallow assertions whose asserted value is the literal `true`, which can never fail.' },
		messages: {
			vacuous:
				'`{{callee}}(true, …)` can never fail. Assert the value the test observed, or delete the arm; a print-only step belongs in an after() hook.',
		},
		schema: [],
	},
	create(context) {
		return {
			CallExpression(node) {
				const [first] = node.arguments;
				if (!first) return;
				const asserted = unwrap(first);
				if (asserted.type !== 'Literal' || asserted.value !== true) return;
				if (!isTruthinessAssertion(context, node.callee)) return;
				context.report({
					node,
					messageId: 'vacuous',
					data: { callee: context.sourceCode.getText(node.callee) },
				});
			},
		};
	},
};

export default {
	meta: { name: 'harper' },
	rules: { 'no-literal-true-assertion': noLiteralTrueAssertion },
};
