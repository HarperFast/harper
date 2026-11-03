'use strict';

// Times one LIKE evaluation in its own process: a backtracking matcher blocks synchronously, so only a parent
// with a kill timeout can bound it. stdin: JSON [<v2|legacy>, pattern, value unit (repeated), value length, escape?],
// since a pattern can exceed Windows' command-line limit. The value unit may instead be a list of [unit, length]
// pairs, one value each; `result` is then a list.
const [engine, pattern, valueUnit, valueLength, escapeOrNull] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const escape = escapeOrNull ?? undefined;
const repeat = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const values = Array.isArray(valueUnit)
	? valueUnit.map(([unit, length]) => repeat(unit, length))
	: [repeat(valueUnit, Number(valueLength))];
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
	matches = (value) => like.eval({ v: value });
} else {
	const alasql = require('alasql');
	require('#src/sqlTranslator/alasqlFunctionImporter').default(alasql);
	matches = (value) =>
		escape === undefined ? alasql.utils.like(pattern, value) : alasql.utils.like(pattern, value, escape);
}
const start = performance.now();
const results = values.map(matches);
const result = Array.isArray(valueUnit) ? results : results[0];
process.stdout.write(JSON.stringify({ result, ms: performance.now() - start }));
