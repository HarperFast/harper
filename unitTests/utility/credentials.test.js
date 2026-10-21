'use strict';

const assert = require('node:assert');
const { CREDENTIAL_KEY, maskCredentialValues } = require('#src/utility/credentials');

function masked(text, before, atSourceStart) {
	const result = maskCredentialValues(text, before, atSourceStart);
	assert.equal(result.length, text.length, 'masking keeps the text length');
	return result;
}

describe('utility/credentials', () => {
	describe('CREDENTIAL_KEY', () => {
		it('matches credential names in camel, snake and kebab case', () => {
			for (const key of [
				'apiKey',
				'OPENAI_API_KEY',
				'x-api-key',
				'privateKey',
				'secretAccessKey',
				'client_secret',
				'password',
				'DB_PASSWD',
				'passphrase',
				'accessToken',
				'sessionToken',
				'authorization',
				'proxy-authorization',
				'set-cookie',
				'credentials',
				'accessKeyId',
				'access_key_id',
				'AWS_ACCESS_KEY_ID',
				'awsAccessKeyId',
			]) {
				assert.ok(CREDENTIAL_KEY.test(key), key);
			}
		});

		it('leaves settings that only contain a credential word unmatched', () => {
			for (const key of [
				'maxTokens',
				'operationTokenTimeout',
				'refreshTokenTimeout',
				'authorizeLocal',
				'requireAuthentication',
				'requireAuthorization',
				'authentication',
				'certificateAuthority',
				'model',
			]) {
				assert.ok(!CREDENTIAL_KEY.test(key), key);
			}
		});
	});

	describe('maskCredentialValues', () => {
		it('masks a YAML credential value and leaves other values and ${VAR} references as they are', () => {
			const config =
				'models:\n  generative:\n    default:\n      apiKey: sk-live\n      model: gpt-5\n' +
				'    other:\n      apiKey: ${OPENAI_API_KEY}\n      quoted: "${X}"\noperationTokenTimeout: 1d\n';
			assert.equal(masked(config), config.replace('sk-live', '*******'));
		});

		it('masks the lines of a value Harper wrote folded, as a block scalar, or as a sequence', () => {
			assert.equal(
				masked('  password: correct horse battery\n    staple\n  model: m\n'),
				'  password: *********************\n    ******\n  model: m\n'
			);
			assert.equal(
				masked('apiKey: |-\n  line one\n\n  line two\nnext: 1\n'),
				'apiKey: **\n  ********\n\n  ********\nnext: 1\n'
			);
			assert.equal(masked('credentials:\n- one\n- two\nb: 1\n'), 'credentials:\n*****\n*****\nb: 1\n');
			assert.equal(
				masked('storage:\n  credentials:\n    region: us\n    secretAccessKey: s\n  bucket: b\n'),
				'storage:\n  credentials:\n    **********\n    ******************\n  bucket: b\n'
			);
		});

		it('treats a credential key followed only by a comment as empty, so its indentless items are masked', () => {
			assert.equal(masked('credentials: # rotated\n- secret\nb: 1\n'), 'credentials: *********\n********\nb: 1\n');
		});

		it('masks a quoted credential that continues onto later lines, whatever their indentation', () => {
			assert.equal(masked('x: {apiKey: "abc\n  def", model: m}\n'), 'x: {apiKey: "***\n  ***", model: m}\n');
			assert.equal(masked('  apiKey: "abc\n  def"\n  model: m\n'), '  apiKey: "***\n  ***"\n  model: m\n');
			assert.equal(masked("  token: 'a\n   b''c'\n  model: m\n"), "  token: '*\n   ****'\n  model: m\n");
		});

		it('ends an unterminated quote at the next column-0 line, as the next log entry', () => {
			assert.equal(
				masked('T [warn]: {"password":"abc\n  def\nT [info]: next\n'),
				'T [warn]: {"password":"***\n  ***\nT [info]: next\n'
			);
		});

		it('masks JSON, inspected and header forms inside a line', () => {
			assert.equal(masked('{"a":"x","apiKey":"sk-\\"q","model":"m"}'), '{"a":"x","apiKey":"******","model":"m"}');
			assert.equal(masked("failed { apiKey: 'sk-a''b', model: 'gpt' }"), "failed { apiKey: '*******', model: 'gpt' }");
			assert.equal(masked('Authorization: Bearer abc.def'), 'Authorization: **************');
			assert.equal(masked('GET /x?api_key=abc&y=1 200'), 'GET /x?api_key=***********');
			assert.equal(masked('token=abc\r\nmodel=m\r\n'), 'token=***\r\nmodel=m\r\n');
		});

		it('masks an unterminated quoted value to the end of the line', () => {
			assert.equal(masked('{"password":"abc'), '{"password":"***');
		});

		it('masks a value that begins before the text, using what precedes it', () => {
			const source = 'models:\n  apiKey: sk-SECRET-VALUE\n  model: m\n';
			const at = source.indexOf('SECRET');
			assert.equal(masked(source.slice(at), source.slice(0, at), true), '************\n  model: m\n');
		});

		it('takes the state from the last column-0 line before the text', () => {
			// `ut of a` is the cut end of an earlier line, so `top:` is the first line known to start in column 0.
			assert.equal(masked('    s1\nb: 2\n', 'ut of a\ntop:\n  apiKey: |\n', false), '    **\nb: 2\n');
			assert.equal(masked('    s1\nb: 2\n', 'ut of a\ntop:\n  model: |\n', false), '    s1\nb: 2\n');
		});

		it('masks every line until a column-0 line when nothing before the text fixes the state', () => {
			const before = 'y\n' + '    s0\n'.repeat(3);
			assert.equal(masked('    s1\n    s2\nb: 2\n', before, false), '    **\n    **\nb: 2\n');
			assert.equal(masked('tail of a long line\nb: 2\n', 'start of a', false), '*******************\nb: 2\n');
		});

		it('treats the source start as a known state', () => {
			assert.equal(masked('    s1\n', '', true), '    s1\n');
		});

		it('keeps the length of text with characters outside the BMP', () => {
			assert.equal(masked('apiKey: 🔑🔑\n'), 'apiKey: ****\n');
		});
	});
});
