'use strict';

const assert = require('node:assert');
const { CREDENTIAL_KEY, maskCredentialFile, maskCredentialValues } = require('#src/utility/credentials');

function masked(text, before, atSourceStart) {
	const result = maskCredentialValues(text, { before, beforeAtSourceStart: atSourceStart });
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
				'headers.authorization',
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

		it('runs an unterminated quote to the end of a single log entry', () => {
			assert.equal(maskCredentialValues('{"apiKey":"sk-a\nsk-b"}', { oneEntry: true }), '{"apiKey":"****\n****"}');
		});

		it('masks every line of a block scalar, quotes inside it included', () => {
			assert.equal(
				masked('apiKey: |-\n  "header\n  footer"\n  sk-live\nnext: 1\n'),
				'apiKey: **\n  *******\n  *******\n  *******\nnext: 1\n'
			);
		});

		it("masks to the end of the line at a single-quoted \\', which only inspected JavaScript reads as an escape", () => {
			const line = "apiKey: 'sk-\\' password: 'sk-real'";
			assert.equal(masked(line), "apiKey: '" + '*'.repeat(line.length - "apiKey: '".length));
		});

		it('finds a key after an escaped backslash', () => {
			assert.equal(masked(String.raw`"\\password: sk-x"`), String.raw`"\\password: *****`);
		});

		it('scans a long run of backslashes once', function () {
			this.timeout(5000);
			const run = `token ${'\\'.repeat(1 << 20)}`;
			assert.equal(masked(run), run);
		});

		it('keeps masking a value across comment lines, which YAML exempts from indentation', () => {
			assert.equal(
				masked('  credentials:\n  # rotated\n  - sk-secret\n'),
				'  credentials:\n  # rotated\n  ***********\n'
			);
			assert.equal(masked('credentials:\n- sk-1\n# c\n- sk-2\nb: 1\n'), 'credentials:\n******\n# c\n******\nb: 1\n');
			assert.equal(masked('  apiKey:\n  # c\n    sk-secret\n'), '  apiKey:\n  # c\n    *********\n');
			const before = 'models:\n  default:\n    apiKey: |-\n      sk-part-1\n# comment\n';
			assert.equal(masked('      sk-part-2\n', before, true), '      *********\n');
		});

		it('finds a key that follows an escape or a dotted path', () => {
			const dump = String.raw`"GET / HTTP/1.1\r\nAuthorization: Bearer sk-live"`;
			assert.equal(
				masked(dump),
				dump.slice(0, dump.indexOf('Bearer')) + '*'.repeat(dump.length - dump.indexOf('Bearer'))
			);
			assert.equal(masked('headers.authorization: Bearer sk-live'), 'headers.authorization: **************');
			const tabbed = String.raw`{\t\"apiKey\":\"sk-tab\"}`;
			assert.equal(masked(tabbed), String.raw`{\t\"apiKey\":\"******\"}`);
		});

		it('masks JSON logged inside a JSON string, keeping the fields around it', () => {
			assert.equal(
				masked('body="{\\"apiKey\\":\\"sk-live\\",\\"model\\":\\"m\\"}"'),
				'body="{\\"apiKey\\":\\"*******\\",\\"model\\":\\"m\\"}"'
			);
			// The inner string's own escaped quote is `\\\"` in the line, and does not close it.
			assert.equal(
				masked('x "{\\"password\\":\\"a\\\\\\"b\\",\\"model\\":\\"m\\"}"'),
				'x "{\\"password\\":\\"******\\",\\"model\\":\\"m\\"}"'
			);
			const deeper = String.raw`body={\\\"apiKey\\\":\\\"sk-deep\\\",\\\"model\\\":\\\"m\\\"}`;
			const at = deeper.indexOf('sk-deep');
			assert.equal(masked(deeper), deeper.slice(0, at) + '*'.repeat(deeper.length - at));
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

	describe('maskCredentialFile', () => {
		const maskedFile = (text) => {
			const file = Buffer.from(text, 'utf8');
			const result = maskCredentialFile(file);
			assert.equal(result.length, file.length, 'masking keeps the byte length');
			return result.toString('utf8');
		};

		it('masks the values of keys only a YAML parse resolves: an escaped key, and the anchor an alias points at', () => {
			const config =
				'common: &k sk-ANCHOR\nmodels:\n  d:\n    "api\\u004Bey": sk-ESCAPED\n  e:\n    apiKey: *k\n    model: m\n';
			assert.equal(
				maskedFile(config),
				'common: &k *********\nmodels:\n  d:\n    "api\\u004Bey": **********\n  e:\n    apiKey: **\n    model: m\n'
			);
		});

		it('keeps line breaks, indentation and  references, and masks a block scalar byte for byte', () => {
			assert.equal(
				maskedFile('a:\n  token: |-\n    é1\n    two\n  key: \n  b: 1\n'),
				'a:\n  token: **\n    ***\n    ***\n  key: \n  b: 1\n'
			);
		});

		it("masks the anchor of an alias nested inside a credential's value", () => {
			assert.equal(
				maskedFile('shared: &k sk-A\ncredentials: [*k]\nother:\n  aws: { secret: *k }\n'),
				'shared: &k ****\ncredentials: ****\nother:\n  aws: { secret: ****\n'
			);
			assert.equal(
				maskedFile('a: &a sk-deep\nm: &m {x: *a}\ncredentials: [*m]\n'),
				'a: &a *******\nm: &m *******\ncredentials: ****\n'
			);
		});

		it('keeps only keys in a file that does not parse, never reading `KEY=value # a: b` as a key', () => {
			const line = 'OPENAI_API_KEY=sk-x # todo: rotate';
			assert.equal(maskedFile(`a: [1\n${line}\nmodel: m\n`), `a: **\n${'*'.repeat(line.length)}\nmodel: *\n`);
			assert.equal(
				maskedFile('a: [1\napiKey: |\n    sk-BROKEN:\nmodel: m\n'),
				'a: **\napiKey: *\n    **********\nmodel: *\n'
			);
		});

		it('masks KEY=value lines, which a YAML parse reads as one string', () => {
			assert.equal(maskedFile('OPENAI_API_KEY=sk-env\nREGION=us\n'), 'OPENAI_API_KEY=******\nREGION=us\n');
		});

		it('returns undefined for bytes that are not UTF-8', () => {
			assert.equal(maskCredentialFile(Buffer.from([0x61, 0x3a, 0x20, 0xff, 0x0a])), undefined);
		});
	});
});
