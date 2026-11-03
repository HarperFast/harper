'use strict';

// Times one LIKE evaluation in its own process: a backtracking matcher blocks synchronously, so only a parent
// with a kill timeout can bound it. argv: <v2|legacy> <pattern> <value unit, repeated> <value length> [escape]
const [engine, pattern, valueUnit, valueLength, escape] = process.argv.slice(2);
const value = valueUnit.repeat(Math.ceil(Number(valueLength) / valueUnit.length)).slice(0, Number(valueLength));
let matches;
if (engine === 'v2') {
	const { compileExpr } = require('#src/sqlEngine/expressions/compile');
	const like = compileExpr({
		kind: 'like',
		expr: { kind: 'column', name: 'v' },
		pattern: { kind: 'literal', value: pattern, sqlType: 'string' },
		negated: false,
		escape,
	});
	matches = () => like.eval({ v: value });
} else {
	const alasql = require('alasql');
	require('#src/sqlTranslator/alasqlFunctionImporter').default(alasql);
	matches = () =>
		escape === undefined ? alasql.utils.like(pattern, value) : alasql.utils.like(pattern, value, escape);
}
const start = performance.now();
const result = matches();
process.stdout.write(JSON.stringify({ result, ms: performance.now() - start }));
