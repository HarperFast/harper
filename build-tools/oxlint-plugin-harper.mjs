const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const TEST_MODULES = new Set(['test', 'node:test']);
const TEST_FUNCTIONS = new Set(['test', 'it']);
const TEST_MODIFIERS = new Set(['skip', 'only', 'todo']);
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

// What an expression resolves to, as far as this rule cares:
//   'module'        a callable truthiness assertion that also carries `.ok`: the assert module itself
//                   and its `default` and `strict` exports
//   'testFunction'  node:test's `test`/`it`, whose callback receives a TestContext
//   'context'       that TestContext
//   'contextAssert' `context.assert`, an object of assert methods (not callable)
//   any other string: the named assert method it resolves to, e.g. 'ok'
// Identifiers resolve through scope, so shadowing is respected; `seen` stops a self-referential binding.

function staticPropertyName(member) {
	if (!member.computed) return member.property.name;
	if (member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
}

function staticKeyName(property) {
	if (!property.computed) return property.key.type === 'Identifier' ? property.key.name : property.key.value;
	if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
}

function exportOrModule(name) {
	return name === 'default' || name === 'strict' ? 'module' : name;
}

function unwrap(node) {
	while (TS_WRAPPERS.has(node.type)) node = node.expression;
	return node;
}

function memberValueOf(object, name) {
	if (object === 'module') return exportOrModule(name);
	if (object === 'testFunction' && TEST_MODIFIERS.has(name)) return 'testFunction';
	if (object === 'context') return name === 'assert' ? 'contextAssert' : name === 'test' ? 'testFunction' : undefined;
	if (object === 'contextAssert') return name;
}

function valueOf(context, node, seen) {
	node = unwrap(node);
	if (node.type === 'Identifier') return bindingValueOf(context, node, seen);
	if (node.type === 'MemberExpression') {
		const name = staticPropertyName(node);
		return name === undefined ? undefined : memberValueOf(valueOf(context, node.object, seen), name);
	}
	if (node.type === 'CallExpression') {
		const [specifier] = node.arguments;
		const isRequire = node.callee.type === 'Identifier' && node.callee.name === 'require';
		return isRequire && specifier?.type === 'Literal' && ASSERT_MODULES.has(specifier.value) ? 'module' : undefined;
	}
}

function importValueOf(definition) {
	const source = definition.parent.source.value;
	const specifier = definition.node;
	const imported =
		specifier.type === 'ImportSpecifier'
			? specifier.imported.type === 'Identifier'
				? specifier.imported.name
				: specifier.imported.value
			: undefined;
	if (ASSERT_MODULES.has(source)) return imported === undefined ? 'module' : exportOrModule(imported);
	if (TEST_MODULES.has(source))
		return imported === undefined || TEST_FUNCTIONS.has(imported) ? 'testFunction' : undefined;
}

// A test callback's first parameter is its TestContext.
function parameterValueOf(context, definition, identifier, seen) {
	const fn = definition.node;
	const call = fn.parent;
	if (fn.params[0]?.type !== 'Identifier' || fn.params[0].name !== identifier.name) return;
	if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return;
	return valueOf(context, call.callee, seen) === 'testFunction' ? 'context' : undefined;
}

function bindingValueOf(context, identifier, seen) {
	for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
		const variable = scope.set.get(identifier.name);
		if (!variable) continue;
		if (seen.has(variable)) return;
		seen.add(variable);
		const definition = variable.defs[0];
		if (definition?.type === 'ImportBinding') return importValueOf(definition);
		if (definition?.type === 'Parameter') return parameterValueOf(context, definition, identifier, seen);
		if (definition?.type !== 'Variable') return;
		const { id, init } = definition.node;
		if (!init) return;
		if (id.type === 'Identifier') return valueOf(context, init, seen);
		if (id.type !== 'ObjectPattern') return;
		const object = valueOf(context, init, seen);
		if (object === undefined) return;
		const property = id.properties.find((candidate) => {
			const value = candidate.value?.type === 'AssignmentPattern' ? candidate.value.left : candidate.value;
			return candidate.type === 'Property' && value?.type === 'Identifier' && value.name === identifier.name;
		});
		const name = property && staticKeyName(property);
		return name === undefined ? undefined : memberValueOf(object, name);
	}
}

function isTruthinessAssertion(context, callee) {
	const value = valueOf(context, callee, new Set());
	return value === 'module' || value === 'ok';
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
