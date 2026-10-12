// Harper's local oxlint rules, loaded through `jsPlugins` in .oxlintrc.json.

const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);

function staticPropertyName(member) {
	if (!member.computed) return member.property.name;
	if (member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
}

function keyName(key) {
	return key.type === 'Identifier' ? key.name : key.value;
}

function exportOrModule(name) {
	return name === 'default' || name === 'strict' ? 'module' : name;
}

// Returns the assert-module export an identifier is bound to ('module' for the callable module
// object itself), or undefined when its binding in scope is not one.
function assertImportOf(context, identifier) {
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
		if (!init || !isAssertModule(context, init)) return;
		if (id.type === 'Identifier') return 'module';
		if (id.type !== 'ObjectPattern') return;
		const property = id.properties.find((candidate) => {
			const value = candidate.value?.type === 'AssignmentPattern' ? candidate.value.left : candidate.value;
			return candidate.type === 'Property' && value?.type === 'Identifier' && value.name === identifier.name;
		});
		return property && !property.computed ? exportOrModule(keyName(property.key)) : undefined;
	}
}

function isAssertModule(context, node) {
	if (node.type === 'Identifier') return assertImportOf(context, node) === 'module';
	if (node.type === 'CallExpression') {
		const [specifier] = node.arguments;
		return (
			node.callee.type === 'Identifier' &&
			node.callee.name === 'require' &&
			specifier?.type === 'Literal' &&
			ASSERT_MODULES.has(specifier.value)
		);
	}
	return (
		node.type === 'MemberExpression' && staticPropertyName(node) === 'strict' && isAssertModule(context, node.object)
	);
}

function isTruthinessAssertion(context, callee) {
	if (callee.type === 'Identifier') {
		const imported = assertImportOf(context, callee);
		return imported === 'module' || imported === 'ok';
	}
	if (callee.type !== 'MemberExpression') return false;
	if (isAssertModule(context, callee)) return true;
	if (staticPropertyName(callee) !== 'ok') return false;
	const target = callee.object;
	// node:test's TestContext exposes the assert methods as `t.assert`.
	return (
		isAssertModule(context, target) || (target.type === 'MemberExpression' && staticPropertyName(target) === 'assert')
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
				if (first?.type !== 'Literal' || first.value !== true) return;
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
