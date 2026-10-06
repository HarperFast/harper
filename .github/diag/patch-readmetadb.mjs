// Diagnostic: inject a stack probe into the built readMetaDb, so load order and timing stay as in CI.
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'dist/resources/databases.js';
const source = readFileSync(file, 'utf8');
const head = 'function readMetaDb(path, defaultTable, databaseName = DEFAULT_DATABASE_NAME, auditPath, isLegacy) {';
if (!source.includes(head)) throw new Error('readMetaDb signature not found');
const probe =
	"if (String(path).includes('existing-target')) { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 60; " +
	"require('node:fs').writeSync(2, 'OPEN existing-target at ' + process.uptime() + 's\\n' + new Error().stack + '\\n'); " +
	'Error.stackTraceLimit = limit; }';
writeFileSync(file, source.replace(head, head + probe));
