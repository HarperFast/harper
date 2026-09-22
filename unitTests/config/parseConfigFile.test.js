'use strict';

const assert = require('node:assert');
const { ConfigParseError, parseConfigFile } = require('#src/config/parseConfigFile');

describe('parseConfigFile', () => {
	it('parses a config file', () => {
		assert.deepEqual(parseConfigFile('foo: bar\n', '/tmp/harperdb-config.yaml'), { foo: 'bar' });
	});

	it('lets a parser fault through with its own message', () => {
		assert.throws(() => parseConfigFile(42, '/tmp/harperdb-config.yaml'), {
			name: 'TypeError',
			message: /source is not a string/,
		});
	});

	// yaml reports a warning through `process.emitWarning`, not a throw, so it goes around
	// `ConfigParseError` entirely — and its framed message would put config source on stderr.
	it('does not warn a config file onto stderr', async () => {
		const warnings = [];
		// Only yaml's own — an unrelated deprecation warning in the same window is not this test's.
		const onWarning = (warning) => warning.name === 'YAMLWarning' && warnings.push(warning);
		process.on('warning', onWarning);
		try {
			parseConfigFile('%FOO bar\n---\nauthentication:\n  password: hunter2\n', '/tmp/harperdb-config.yaml');
			// `process.emitWarning` reports on the next tick.
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off('warning', onWarning);
		}

		assert.deepEqual(
			warnings.map((warning) => warning.name),
			[],
			`the parser warned about the config file: ${warnings.map((warning) => warning.message).join('; ')}`
		);
	});

	it('reports where a malformed file failed without repeating its contents', () => {
		const contents = 'authentication:\n  operationTokenTimeout: [unclosed\n  password: hunter2\n';

		assert.throws(
			() => parseConfigFile(contents, '/tmp/harperdb-config.yaml'),
			(error) => {
				assert.ok(error instanceof ConfigParseError);
				assert.ok(!error.message.includes('hunter2'), `the parse error framed the source: ${error.message}`);
				assert.ok(error.message.includes('/tmp/harperdb-config.yaml'), 'names the file that failed');
				assert.ok(/line \d+, column \d+/.test(error.message), 'locates the failure');
				assert.equal(error.cause, undefined, 'a cause would carry the framed message back into the log');
				return true;
			}
		);
	});
});
