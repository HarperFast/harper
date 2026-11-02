'use strict';

// Times one LIKE evaluation in its own process: a backtracking matcher blocks synchronously, so only a parent
// with a kill timeout can bound it. argv: <v2|legacy> <pattern> <value char> <value length>
const [engine, pattern, valueChar, valueLength] = process.argv.slice(2);
const value = valueChar.repeat(Number(valueLength));
let matches;
if (engine === 'v2') {
	const { compileExpr } = require('#src/sqlEngine/expressions/compile');
	const like = compileExpr({
		kind: 'like',
		expr: { kind: 'column', name: 'v' },
		pattern: { kind: 'literal', value: pattern, sqlType: 'string' },
		negated: false,
	});
	matches = () => like.eval({ v: value });
} else {
	const alasql = require('alasql');
	require('#src/sqlTranslator/alasqlFunctionImporter').default(alasql);
	matches = () => alasql.utils.like(pattern, value);
}
const start = performance.now();
const result = matches();
process.stdout.write(JSON.stringify({ result, ms: performance.now() - start }));
