'use strict';

// Tokenizes stdin in its own process and prints the milliseconds taken: a backtracking rule blocks synchronously,
// so only a parent with a kill timeout can bound it.
const { tokenize } = require('#src/sqlTranslator/parser/lexer');
const input = require('node:fs').readFileSync(0, 'utf8');
const start = performance.now();
const tokens = tokenize(input);
process.stdout.write(JSON.stringify({ ms: performance.now() - start, second: tokens[1].type }));
