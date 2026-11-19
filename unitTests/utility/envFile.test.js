'use strict';

const assert = require('node:assert');
const { parse } = require('dotenv');
const {
	isEnvFile,
	isExampleEnvFile,
	isProtectedEnvFile,
	parseEnvKeys,
	renderMaskedEnv,
	formatEnvValue,
	upsertEnvValues,
	removeEnvKeys,
	isEncryptedEnvValue,
	ENV_VALUE_MASK,
	ENV_ENCRYPTED_PREFIX,
} = require('#src/utility/envFile');

describe('envFile', () => {
	describe('isEnvFile', () => {
		it('matches .env and .env.<suffix>', () => {
			assert.equal(isEnvFile('.env'), true);
			assert.equal(isEnvFile('.env.local'), true);
			assert.equal(isEnvFile('.env.production'), true);
			assert.equal(isEnvFile('app/.env'), true);
			assert.equal(isEnvFile('deep/nested/.env.test'), true);
		});

		it('does not match non-env files', () => {
			assert.equal(isEnvFile('env.js'), false);
			assert.equal(isEnvFile('config.env'), false);
			assert.equal(isEnvFile('config.env.ts'), false);
			assert.equal(isEnvFile('.environment'), false);
			assert.equal(isEnvFile('.envrc'), false);
			assert.equal(isEnvFile(''), false);
			assert.equal(isEnvFile(undefined), false);
		});
	});

	describe('isExampleEnvFile / isProtectedEnvFile', () => {
		it('treats template env files as examples that are not protected', () => {
			for (const f of [
				'.env.example',
				'.env.sample',
				'.env.template',
				'.env.local.example',
				'.ENV.SAMPLE',
				'app/.env.example',
			]) {
				assert.equal(isEnvFile(f), true, `isEnvFile ${f}`);
				assert.equal(isExampleEnvFile(f), true, `isExampleEnvFile ${f}`);
				assert.equal(isProtectedEnvFile(f), false, `isProtectedEnvFile ${f}`);
			}
		});

		it('treats real env files as protected, not examples (case-insensitive)', () => {
			for (const f of ['.env', '.env.local', '.env.production', 'deep/.env', '.ENV', '.Env.Production']) {
				assert.equal(isExampleEnvFile(f), false, `isExampleEnvFile ${f}`);
				assert.equal(isProtectedEnvFile(f), true, `isProtectedEnvFile ${f}`);
			}
		});

		it('does not treat non-env files as examples even with a template suffix', () => {
			assert.equal(isExampleEnvFile('config.example'), false);
			assert.equal(isProtectedEnvFile('config.example'), false);
			assert.equal(isProtectedEnvFile('env.js'), false);
		});
	});

	describe('isEncryptedEnvValue', () => {
		it('recognizes the enc:v1 envelope prefix', () => {
			assert.equal(ENV_ENCRYPTED_PREFIX, 'enc:v1:');
			assert.equal(isEncryptedEnvValue('enc:v1:abc123'), true);
			assert.equal(isEncryptedEnvValue(`${ENV_ENCRYPTED_PREFIX}anything`), true);
		});

		it('treats plaintext and non-strings as not encrypted', () => {
			assert.equal(isEncryptedEnvValue('plain'), false);
			assert.equal(isEncryptedEnvValue('enc:v2:abc'), false);
			assert.equal(isEncryptedEnvValue('ENC:V1:abc'), false); // case-sensitive marker
			assert.equal(isEncryptedEnvValue(''), false);
			assert.equal(isEncryptedEnvValue(undefined), false);
			assert.equal(isEncryptedEnvValue(123), false);
		});
	});

	describe('parseEnvKeys', () => {
		it('returns key names in file order, ignoring comments and blanks', () => {
			const text = '# a comment\nAPI_KEY=secret123\n\nDB_URL=postgres://x\n';
			assert.deepEqual(parseEnvKeys(text), ['API_KEY', 'DB_URL']);
		});

		it('handles export prefixes and de-dupes (last wins, single entry)', () => {
			const text = 'export FOO=1\nFOO=2\nBAR=3\n';
			assert.deepEqual(parseEnvKeys(text), ['FOO', 'BAR']);
		});

		it('returns no keys for empty text', () => {
			assert.deepEqual(parseEnvKeys(''), []);
			assert.deepEqual(parseEnvKeys('# only a comment\n'), []);
		});
	});

	describe('renderMaskedEnv', () => {
		it('renders one masked line per key and never leaks a value', () => {
			assert.equal(renderMaskedEnv(['API_KEY', 'DB_URL']), `API_KEY=${ENV_VALUE_MASK}\nDB_URL=${ENV_VALUE_MASK}\n`);
		});

		it('is empty for no keys', () => {
			assert.equal(renderMaskedEnv([]), '');
		});
	});

	describe('formatEnvValue', () => {
		// round-trip: writing KEY=<formatted> and parsing it back yields the original value
		const roundTrips = (value) => parse(`KEY=${formatEnvValue(value)}\n`).KEY;

		it('leaves simple values bare', () => {
			assert.equal(formatEnvValue('abc123'), 'abc123');
			assert.equal(formatEnvValue('postgres://u:p@h:5432/db?ssl=true'), 'postgres://u:p@h:5432/db?ssl=true');
		});

		it('emits an empty value bare', () => {
			assert.equal(formatEnvValue(''), '');
			assert.equal(roundTrips(''), '');
		});

		it('quotes values with spaces, #, or leading/trailing whitespace', () => {
			for (const v of ['hello world', 'has#hash', '  padded  ', 'a=b c']) {
				assert.equal(roundTrips(v), v, `failed round trip for ${JSON.stringify(v)}`);
			}
		});

		it('round-trips quote characters', () => {
			assert.equal(roundTrips('has"double'), 'has"double');
			assert.equal(roundTrips("has'single"), "has'single");
			assert.equal(roundTrips('back`tick'), 'back`tick');
		});

		it('round-trips backslashes and newlines', () => {
			assert.equal(roundTrips('a\\b\\c'), 'a\\b\\c');
			assert.equal(roundTrips('line1\nline2'), 'line1\nline2');
			assert.equal(roundTrips("has'single\nand newline"), "has'single\nand newline");
		});

		it('throws only on the unrepresentable both-quotes case', () => {
			assert.throws(() => formatEnvValue(`both ' and "`));
		});
	});

	describe('upsertEnvValues', () => {
		it('replaces an existing value in place, preserving everything else', () => {
			const text = '# header\nAPI_KEY=old\nDB_URL=postgres://x\n# trailing note\n';
			const result = upsertEnvValues(text, { API_KEY: 'rotated' });
			assert.equal(result, '# header\nAPI_KEY=rotated\nDB_URL=postgres://x\n# trailing note\n');
			assert.deepEqual(parse(result), { API_KEY: 'rotated', DB_URL: 'postgres://x' });
		});

		it('appends a new key without disturbing others', () => {
			const text = 'API_KEY=secret\n';
			const result = upsertEnvValues(text, { NEW_ONE: 'x' });
			assert.equal(result, 'API_KEY=secret\nNEW_ONE=x\n');
		});

		it('upserts multiple keys at once (replace + append)', () => {
			const text = 'A=1\nB=2\n';
			const result = upsertEnvValues(text, { B: '22', C: '3' });
			assert.deepEqual(parse(result), { A: '1', B: '22', C: '3' });
			assert.ok(result.startsWith('A=1\nB=22\n'));
		});

		it('creates content from an empty file', () => {
			assert.equal(upsertEnvValues('', { A: '1', B: '2' }), 'A=1\nB=2\n');
		});

		it('preserves the export prefix and indentation when updating', () => {
			assert.equal(upsertEnvValues('export FOO=old\n', { FOO: 'new' }), 'export FOO=new\n');
		});

		it('collapses a duplicate assignment of an updated key so the new value wins', () => {
			const text = 'FOO=1\nFOO=2\n';
			const result = upsertEnvValues(text, { FOO: '9' });
			assert.equal(result, 'FOO=9\n');
			assert.deepEqual(parse(result), { FOO: '9' });
		});

		it('does not corrupt a multi-line quoted value belonging to another key', () => {
			// CERT spans 3 lines; a continuation line looks like an assignment (OTHER=...).
			const text = 'CERT="line1\nOTHER=line2\nline3"\nNAME=keep\n';
			const result = upsertEnvValues(text, { OTHER: 'injected' });
			// CERT stays intact, OTHER is appended as a brand-new key (the look-alike was inside CERT).
			const parsed = parse(result);
			assert.equal(parsed.CERT, 'line1\nOTHER=line2\nline3');
			assert.equal(parsed.NAME, 'keep');
			assert.equal(parsed.OTHER, 'injected');
		});

		it('quotes a value that needs it when writing', () => {
			const result = upsertEnvValues('A=1\n', { B: 'two words' });
			assert.equal(result, "A=1\nB='two words'\n");
			assert.equal(parse(result).B, 'two words');
		});

		it('adds new keys to a file with no trailing newline', () => {
			assert.equal(upsertEnvValues('A=1', { B: '2' }), 'A=1\nB=2\n');
		});

		it('treats a single-quoted value ending in a backslash as closed on its line', () => {
			// A Windows path closes on its own line; the following key must not be swallowed as a
			// continuation (which would corrupt it and append a duplicate).
			const text = "WINPATH='C:\\Users\\name\\'\nNEXT=keep\n";
			const result = upsertEnvValues(text, { NEXT: 'changed' });
			assert.ok(result.includes("WINPATH='C:\\Users\\name\\'"), 'WINPATH preserved verbatim');
			assert.equal(parse(result).NEXT, 'changed');
			assert.equal((result.match(/^NEXT=/gm) || []).length, 1, 'NEXT updated in place, not duplicated');
		});

		it('treats a backtick-quoted value ending in a backslash as closed on its line', () => {
			// dotenv treats backtick values literally (like single quotes), so this closes on its line.
			const text = 'WINPATH=`C:\\Users\\name\\`\nNEXT=keep\n';
			const result = upsertEnvValues(text, { NEXT: 'changed' });
			assert.ok(result.includes('WINPATH=`C:\\Users\\name\\`'), 'WINPATH preserved verbatim');
			assert.equal(parse(result).NEXT, 'changed');
			assert.equal((result.match(/^NEXT=/gm) || []).length, 1, 'NEXT updated in place, not duplicated');
		});
	});

	describe('removeEnvKeys', () => {
		it('removes a single key, leaving the rest', () => {
			const text = '# note\nA=1\nB=2\nC=3\n';
			assert.equal(removeEnvKeys(text, 'B'), '# note\nA=1\nC=3\n');
		});

		it('removes multiple keys', () => {
			assert.deepEqual(parse(removeEnvKeys('A=1\nB=2\nC=3\n', ['A', 'C'])), { B: '2' });
		});

		it('removes a multi-line quoted value entirely', () => {
			const text = 'CERT="l1\nl2\nl3"\nNAME=keep\n';
			assert.equal(removeEnvKeys(text, 'CERT'), 'NAME=keep\n');
		});

		it('is a no-op when the key is absent', () => {
			assert.equal(removeEnvKeys('A=1\n', 'Z'), 'A=1\n');
		});
	});
});
