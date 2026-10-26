'use strict';

/**
 * Agent credential masking (#3097, PR #3412). The documented contract (agent/DESIGN.md "Credential values never
 * leave a read-only source unmasked"): text from the read-only `config` and `logs` scopes and every text field of an
 * agent `read_log` entry reaches the model masked. This spec drives the reads the end-to-end test
 * (integrationTests/server/agent-credential-masking.test.ts) does not: YAML forms a text scan would miss, paged
 * reads into a value, tail fragments, grep against the raw value, the size/encoding refusals, and the read_log
 * guard's argument/result/error paths.
 *
 * Every sentinel starts with `sk-cm-`; the generic oracle is "no sentinel reaches a tool result" unless the arm
 * pins a documented limit, in which case it says so. Arms that pin a limit as measured (URL userinfo, a column-0
 * continuation, flow-mapping siblings masked with a credential) flip when that limit changes, deliberately.
 *
 * Promoted from qa-explorer SQA-71 / SP-62: green on the PR head and on main after the merge (ccd6db847); the
 * same oracle was 3/4 red on main before the PR (d1dfab6e7), so the spec detects the masking's absence.
 */

const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readFileTool, grepFilesTool, tailFileTool } = require('#src/agent/tools/fsTools');
const { maskCredentialValues, maskCredentialFile } = require('#src/utility/credentials');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { composeRegistryTools, _resetRegistryToolsForTests } = require('#src/agent/registryTools');

const S = (tag) => `sk-cm-${tag}`;
const SENTINEL = /sk-cm-[\w-]+/g;

function mkScopes() {
	const root = mkdtempSync(join(tmpdir(), 'credential-masking-'));
	const componentsRoot = join(root, 'components');
	const logDir = join(root, 'logs');
	const configDir = join(root, 'config');
	mkdirSync(componentsRoot);
	mkdirSync(logDir);
	mkdirSync(configDir);
	return { componentsRoot, logDir, configDir, configFile: 'harper-config.yaml', keyDirs: [join(root, 'keys')], root };
}
const ctx = (scopes, maxResultBytes) => ({
	sessionId: 'credential-masking',
	scopes,
	...(maxResultBytes ? { maxResultBytes } : {}),
});
const leaked = (text) => [...new Set(String(text).match(SENTINEL) ?? [])];

const CONFIG_YAML = [
	'models:',
	'  generative:',
	'    default:',
	`      apiKey: ${S('plain')}`,
	'      maxTokens: 4096',
	`"quotedApiKey": ${S('quoted-key')}`,
	`"escaped\\u0041piKey": ${S('escaped-key')}`,
	`anchorsrc: &anc ${S('anchored')}`,
	'secretRef: *anc',
	'keyAlias: &kk aliasApiKey',
	`*kk : ${S('alias-key')}`,
	'blockKey: |',
	`  ${S('block-1')}`,
	`  ${S('block-2')}`,
	`flow: { password: ${S('flow')}, user: bob }`,
	'seq:',
	`  - token: ${S('seq')}`,
	'  - name: visible-item',
	'apiKeyEnv: ${OPENAI_API_KEY}',
	'apiKeyEnvQuoted: "${OPENAI_API_KEY}"',
	`url: https://user:${S('url-userinfo')}@host/`,
	`# comment apiKey: ${S('comment')}`,
	'notes: |',
	`  OPERATOR_TOKEN=${S('env-line')} # a KEY=value line inside a block scalar; the scan finds it`,
	'---',
	'second:',
	`  passphrase: ${S('doc2')}`,
	'',
].join('\n');

describe('agent credential masking — config scope', () => {
	let scopes;
	beforeEach(() => {
		scopes = mkScopes();
	});

	it('A: YAML forms — every credential-keyed value is masked, ordinary settings and env placeholders stay', async () => {
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), CONFIG_YAML);
		const { content } = await readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes));
		const leaks = leaked(content);
		// Documented limit: a credential inside a URL under a non-credential key is not masked (DESIGN.md "Not covered").
		const pinnedLimits = [S('url-userinfo')];
		assert.deepEqual(
			leaks.filter((l) => !pinnedLimits.includes(l)),
			[],
			`sentinels reached the model from the config scope:\n${content}`
		);
		assert.ok(content.includes('maxTokens: 4096'), 'maxTokens stays readable');
		// Observation (over-masking, not a leak): the text scan masks an unquoted plain value to the end of its line,
		// and the file mask is the union of parse ranges and scan, so a flow-mapping sibling after a credential key
		// on the same line is hidden too. Pinned as measured; a precision fix would flip this assert.
		assert.match(
			content,
			/flow: \{ password: \*+\n/,
			'flow-mapping siblings after the credential are masked with it (measured)'
		);
		assert.ok(!content.includes('user: bob'), 'pinned over-mask: `user: bob` after `password:` on one line is hidden');
		assert.ok(content.includes('name: visible-item'), 'non-credential sequence item stays readable');
		assert.ok(content.includes('apiKeyEnv: ${OPENAI_API_KEY}'), 'bare env placeholder stays');
		assert.ok(content.includes('apiKeyEnvQuoted: "${OPENAI_API_KEY}"'), 'quoted env placeholder stays');
		assert.equal(content.length, CONFIG_YAML.length, 'mask keeps length');
		// Pin the limit so a change in either direction is visible.
		assert.ok(content.includes(S('url-userinfo')), 'pinned limit: userinfo in a URL value is NOT masked');
	});

	it('B: read_file offset into a long masked value — page starts with *s, nextOffset stays raw', async () => {
		const long = S('long-') + 'x'.repeat(1500);
		const file = `name: ok\napiKey: ${long}\nafter: fine\n`;
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), file);
		const valueStart = file.indexOf(long);
		const c = ctx(scopes, 2048); // page = 1024 bytes, so the value straddles pages
		const first = await readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, c);
		assert.deepEqual(leaked(first.content), [], `page 1 leaked:\n${first.content}`);
		assert.equal(first.nextOffset, 9, 'page 1 is the first line alone: the long line does not fit beside it');
		const second = await readFileTool.handler(
			{ root: 'config', path: 'harper-config.yaml', offset: first.nextOffset },
			c
		);
		assert.deepEqual(leaked(second.content), [], `page 2 leaked:\n${second.content}`);
		assert.equal(second.lineTruncated, true);
		assert.match(
			second.content,
			/^apiKey: \*+$/,
			`page 2 is the cut long line, masked: ${second.content.slice(0, 40)}`
		);
		assert.ok(
			second.nextOffset > valueStart && second.nextOffset < valueStart + long.length,
			`page 2 ends inside the value: ${second.nextOffset}`
		);
		const third = await readFileTool.handler(
			{ root: 'config', path: 'harper-config.yaml', offset: second.nextOffset },
			c
		);
		assert.deepEqual(leaked(third.content), [], `page 3 leaked:\n${third.content}`);
		assert.match(
			third.content,
			/^\*+\nafter: fine\n$/,
			`page 3 is the rest of the value as *s then the next line:\n${third.content.slice(0, 60)}`
		);
		const mid = await readFileTool.handler(
			{ root: 'config', path: 'harper-config.yaml', offset: valueStart + 10, lineCount: 1 },
			c
		);
		assert.match(
			mid.content,
			/^\*+$/,
			`offset into the value must be all *s: ${JSON.stringify(mid.content.slice(0, 40))}`
		);
		assert.equal(mid.offset, valueStart + 10);
		const byLine = await readFileTool.handler(
			{ root: 'config', path: 'harper-config.yaml', startLine: 2, lineCount: 1 },
			c
		);
		assert.match(byLine.content, /^apiKey: \*+$/, `startLine paging: ${byLine.content.slice(0, 40)}`);
	});

	it('C: tail_file on the config file — a trailing credential line, and one longer than the page, come back masked', async () => {
		const file = `name: ok\nbefore: 1\npassword: ${S('tail')}\n`;
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), file);
		const t = await tailFileTool.handler({ root: 'config', path: 'harper-config.yaml', lines: 2 }, ctx(scopes));
		assert.deepEqual(t.lines, ['before: 1', `password: ${'*'.repeat(S('tail').length)}`]);
		const long = S('tail-long-') + 'y'.repeat(3000);
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), `name: ok\ntoken: ${long}\n`);
		const cut = await tailFileTool.handler({ root: 'config', path: 'harper-config.yaml', lines: 5 }, ctx(scopes, 2048));
		assert.equal(cut.truncated, true);
		assert.deepEqual(leaked(cut.lines.join('\n')), [], `cut tail leaked: ${cut.lines.join('|').slice(0, 80)}`);
		assert.match(cut.lines[cut.lines.length - 1], /^\*+$/, 'the cut fragment of the value is all *s');
	});

	it('D: grep_files in the config scope — the raw value never matches, the key line comes back masked', async () => {
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), CONFIG_YAML);
		const raw = await grepFilesTool.handler({ root: 'config', pattern: S('plain') }, ctx(scopes));
		assert.equal(raw.count, 0, `grep for the raw value must not confirm it: ${JSON.stringify(raw)}`);
		const prefix = await grepFilesTool.handler({ root: 'config', pattern: 'sk-cm' }, ctx(scopes));
		// Only the pinned URL limit may match.
		assert.deepEqual(
			prefix.results.map((r) => r.text).filter((t) => !t.includes('url:')),
			[],
			JSON.stringify(prefix.results)
		);
		const key = await grepFilesTool.handler({ root: 'config', pattern: 'apiKey', flags: '' }, ctx(scopes));
		assert.ok(key.count >= 1);
		for (const r of key.results) assert.deepEqual(leaked(r.text), [], r.text);
		assert.ok(
			key.results.some((r) => /apiKey: \*+$/.test(r.text)),
			JSON.stringify(key.results)
		);
	});

	it('E: refusals — over 256 KiB, non-UTF-8, and a file that does not parse keeps only its keys', async () => {
		const big = `apiKey: ${S('big')}\n` + '#'.repeat(256 * 1024) + '\n';
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), big);
		await assert.rejects(
			readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes)),
			/cannot be checked for credentials/
		);
		await assert.rejects(
			tailFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes)),
			/cannot be checked for credentials/
		);
		const bigGrep = await grepFilesTool.handler({ root: 'config', pattern: 'sk-cm' }, ctx(scopes));
		assert.equal(bigGrep.count, 0);
		assert.equal(bigGrep.skippedFiles, 1);

		writeFileSync(
			join(scopes.configDir, 'harper-config.yaml'),
			Buffer.concat([Buffer.from(`apiKey: ${S('bin')}\n`), Buffer.from([0xff, 0xfe, 0x00])])
		);
		await assert.rejects(
			readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes)),
			/not UTF-8/
		);
		const binGrep = await grepFilesTool.handler({ root: 'config', pattern: 'sk-cm' }, ctx(scopes));
		assert.equal(binGrep.count, 0);

		const broken = `plain: visible-plain\napiKey: ${S('broken')}\nlist: [unclosed\n`;
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), broken);
		const { content } = await readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes));
		assert.deepEqual(leaked(content), [], content);
		assert.ok(content.startsWith('plain: ***'), `keys stay, every value masked:\n${content}`);
		assert.ok(!content.includes('visible-plain'), 'a non-credential value is masked too when the file does not parse');
	});

	it('F: an inline PEM private key in the config file is refused, not masked', async () => {
		const pem = `tls:\n  privateKey: |\n    -----BEGIN PRIVATE KEY-----\n    MIIB${'A'.repeat(60)}\n    -----END PRIVATE KEY-----\n  apiKey: ${S('pem-sibling')}\n`;
		writeFileSync(join(scopes.configDir, 'harper-config.yaml'), pem);
		await assert.rejects(
			readFileTool.handler({ root: 'config', path: 'harper-config.yaml' }, ctx(scopes)),
			/key material/
		);
		const g = await grepFilesTool.handler({ root: 'config', pattern: 'apiKey' }, ctx(scopes));
		assert.equal(g.count, 0, 'a file holding PEM armor is skipped whole by grep');
	});
});

const LOG_LINES = [
	`2026-10-24T12:00:00.000Z [main/0] [warn]: upstream failed {"apiKey":"${S('log-json')}","status":500}`,
	`2026-10-24T12:00:01.000Z [main/0] [info]: body "{\\"token\\":\\"${S('log-nested')}\\"}" sent`,
	`2026-10-24T12:00:02.000Z [main/0] [debug]: headers Authorization: Bearer ${S('log-bearer')}`,
	`2026-10-24T12:00:03.000Z [main/0] [info]: GET /api?token=${S('log-query')}&b=1 200`,
	`2026-10-24T12:00:04.000Z [main/0] [error]: client { apiKey: '${S('log-inspect')}', other: 1 }`,
	`2026-10-24T12:00:05.000Z [main/0] [warn]: password: '${S('log-esc')}\\'more' tail`,
	`2026-10-24T12:00:06.000Z [main/0] [warn]: apiKey: |-`,
	`  ${S('log-block-1')}`,
	`  ${S('log-block-2')}`,
	`2026-10-24T12:00:07.000Z [main/0] [error]: Error: boom secret=${S('log-eq')}`,
	`    at Object.<anonymous> (/srv/app.js:1:1)`,
	`2026-10-24T12:00:08.000Z [main/0] [info]: {"secret":"${S('log-cont-1')}`,
	`${S('log-cont-2')}"}`,
	`2026-10-24T12:00:09.000Z [main/0] [info]: done`,
	'',
];

describe('agent credential masking — logs scope', () => {
	let scopes;
	let logText;
	beforeEach(() => {
		scopes = mkScopes();
		logText = LOG_LINES.join('\n');
		writeFileSync(join(scopes.logDir, 'hdb.log'), logText);
	});

	it('G: log text forms — JSON, nested JSON, header, query string, inspected object, block scalar, key=value, stack', async () => {
		const { content } = await readFileTool.handler({ root: 'logs', path: 'hdb.log' }, ctx(scopes));
		const pinnedLimits = [S('log-cont-2')]; // DESIGN.md: a column-0 continuation in a log file is not followed
		assert.deepEqual(
			leaked(content).filter((l) => !pinnedLimits.includes(l)),
			[],
			`log sentinels reached the model:\n${content}`
		);
		assert.ok(content.includes('at Object.<anonymous> (/srv/app.js:1:1)'), 'the stack under an error stays readable');
		assert.ok(content.includes('"status":500'), 'a non-credential JSON field stays readable');
		assert.ok(content.includes('other: 1 }'), 'the inspected object after the masked value stays readable');
		assert.ok(content.includes(S('log-cont-2')), 'pinned limit: column-0 continuation of a quoted value is NOT masked');
	});

	it('H: read_file offset into a logged value uses the look-back — the page starts masked', async () => {
		const c = ctx(scopes, 2048);
		const at = logText.indexOf(S('log-json')) + 4;
		const page = await readFileTool.handler({ root: 'logs', path: 'hdb.log', offset: at, lineCount: 1 }, c);
		const rest = S('log-json').length - 4;
		assert.match(page.content, new RegExp(`^\\*{${rest}}","status":500}\n?$`), `offset page: ${page.content}`);
		const block = await readFileTool.handler(
			{ root: 'logs', path: 'hdb.log', offset: logText.indexOf(`  ${S('log-block-2')}`), lineCount: 1 },
			c
		);
		assert.match(
			block.content,
			/^ {2}\*+\n?$/,
			`block-scalar continuation line read from its own offset: ${JSON.stringify(block.content)}`
		);
		const stack = await readFileTool.handler(
			{ root: 'logs', path: 'hdb.log', offset: logText.indexOf('    at Object'), lineCount: 1 },
			c
		);
		assert.equal(
			stack.content.trimEnd(),
			'    at Object.<anonymous> (/srv/app.js:1:1)',
			'a stack line read from its own offset stays readable'
		);
	});

	it('I: tail_file and grep_files in the logs scope', async () => {
		const t = await tailFileTool.handler({ root: 'logs', path: 'hdb.log', lines: 4 }, ctx(scopes));
		const pinnedLimits = [S('log-cont-2')];
		assert.deepEqual(
			leaked(t.lines.join('\n')).filter((l) => !pinnedLimits.includes(l)),
			[],
			JSON.stringify(t.lines)
		);
		const raw = await grepFilesTool.handler({ root: 'logs', pattern: S('log-bearer') }, ctx(scopes));
		assert.equal(raw.count, 0, JSON.stringify(raw));
		const all = await grepFilesTool.handler({ root: 'logs', pattern: 'sk-cm' }, ctx(scopes));
		assert.deepEqual(
			all.results.map((r) => r.text).filter((l) => leaked(l).some((s) => !pinnedLimits.includes(s))),
			[],
			JSON.stringify(all.results)
		);
	});

	it('J: a block-scalar value straddling a 128 KiB look-back is still masked (state from the last column-0 line)', async () => {
		const body = Array.from({ length: 5000 }, (_, i) => `  ${S(`far-${i}`)}-${'z'.repeat(20)}`).join('\n');
		const text = `2026-10-24T12:00:00.000Z [main/0] [warn]: apiKey: |-\n${body}\n2026-10-24T12:00:01.000Z [main/0] [info]: done\n`;
		writeFileSync(join(scopes.logDir, 'big.log'), text);
		assert.ok(body.length > 128 * 1024, `body ${body.length} must exceed the look-back`);
		const at = text.indexOf(S('far-4990'));
		const page = await readFileTool.handler(
			{ root: 'logs', path: 'big.log', offset: at - 2, lineCount: 2 },
			ctx(scopes, 2048)
		);
		assert.deepEqual(leaked(page.content), [], `page past the look-back leaked:\n${page.content}`);
	});
});

describe('agent credential masking — read_log guard', () => {
	const SU = { username: 'agent', role: { permission: { super_user: true } } };
	let calls;
	function stubReadLog(result) {
		addTool({
			name: 'read_log',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			profile: 'operations',
			visibleTo: () => true,
			handler: async (args) => {
				calls.push(args);
				return typeof result === 'function' ? result(args) : result;
			},
		});
		const [tool] = composeRegistryTools(SU, async () => SU);
		assert.equal(tool.def.name, 'read_log');
		return tool;
	}
	beforeEach(() => {
		calls = [];
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	const c = { sessionId: 'credential-masking', scopes: mkScopes() };

	it('K: filter is refused before dispatch; from/until/level/start/limit pass through', async () => {
		const tool = stubReadLog({ content: [], structuredContent: { results: [] } });
		await assert.rejects(tool.handler({ filter: 'x', limit: 1 }, c), /filter is not available/);
		assert.equal(calls.length, 0, 'the operation was never dispatched');
		await assert.rejects(
			tool.handler({ filter: '', limit: 1 }, c),
			/filter is not available/,
			'an empty filter is still a filter'
		);
		const ok = await tool.handler(
			{ from: '2026-01-01', until: '2026-12-31', level: 'warn', start: 0, limit: 5, order: 'desc' },
			c
		);
		assert.deepEqual(ok, { results: [] });
		assert.equal(calls.length, 1);
	});

	it('L: every text field of every entry is masked, numbers/booleans/null pass, tags arrays are masked per item', async () => {
		const entries = [
			{
				timestamp: '2026-10-24T12:00:00.000Z',
				level: 'warn',
				thread: 'main/0',
				tags: ['auth', `token=${S('tag')}`],
				message: `upstream {"apiKey":"${S('entry-1')}"}`,
			},
			{
				timestamp: '2026-10-24T12:00:01.000Z',
				level: 'error',
				thread: null,
				pid: 42,
				ok: false,
				message: `password: "${S('entry-open')}\nnext line still inside the quote\n  deeper: ${S('entry-deeper')}`,
			},
		];
		const tool = stubReadLog({ content: [{ type: 'text', text: 'x' }], structuredContent: { results: entries } });
		const out = await tool.handler({ limit: 2 }, c);
		assert.deepEqual(leaked(JSON.stringify(out)), [], JSON.stringify(out, null, 1));
		assert.equal(out.results[1].pid, 42);
		assert.equal(out.results[1].ok, false);
		assert.equal(out.results[1].thread, null);
		assert.equal(out.results[0].tags[0], 'auth');
		assert.ok(
			!out.results[1].message.includes('next line still inside'),
			`an open quote runs to the entry end: ${out.results[1].message}`
		);
	});

	it('M: an entry with a non-string object field, or a result without a results array, is withheld', async () => {
		const tool = stubReadLog({
			content: [],
			structuredContent: { results: [{ timestamp: 't', message: 'm', meta: { apiKey: S('obj') } }] },
		});
		await assert.rejects(tool.handler({ limit: 1 }, c), (e) => !leaked(e.message).length && /withheld/.test(e.message));
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
		const textOnly = stubReadLog({ content: [{ type: 'text', text: `apiKey=${S('text-only')}` }] });
		await assert.rejects(
			textOnly.handler({ limit: 1 }, c),
			(e) => !leaked(e.message).length && /withheld/.test(e.message)
		);
	});

	it('N: PEM armor in any field replaces the entry; error text is masked; an error holding PEM is withheld', async () => {
		const tool = stubReadLog({
			content: [],
			structuredContent: {
				results: [
					{ timestamp: 't1', message: 'fine' },
					{
						timestamp: 't2',
						level: 'info',
						message: `-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----`,
						tags: [S('pem-tag')],
					},
				],
			},
		});
		const out = await tool.handler({}, c);
		assert.deepEqual(out.results[0], { timestamp: 't1', message: 'fine' });
		assert.deepEqual(out.results[1], { timestamp: 't2', message: 'Refused: this log entry holds a PEM private key' });
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
		const err = stubReadLog({
			isError: true,
			content: [{ type: 'text', text: `read failed for password=${S('err')} at line 3` }],
		});
		await assert.rejects(err.handler({}, c), (e) => {
			assert.deepEqual(leaked(e.message), [], e.message);
			assert.ok(e.message.includes('read failed for password='), e.message);
			return true;
		});
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
		const pemErr = stubReadLog({
			isError: true,
			content: [{ type: 'text', text: `x -----BEGIN RSA PRIVATE KEY----- ${S('pem-err')}` }],
		});
		await assert.rejects(pemErr.handler({}, c), (e) => !leaked(e.message).length && /withheld/.test(e.message));
	});
});

describe('agent credential masking — library edges', () => {
	it('O: maskCredentialValues on inspected/JSON forms the scan documents', () => {
		const cases = [
			[`{ "Authorization": "Basic ${S('basic')}" }`, /\*+/],
			[`x-api-key=${S('hdr')}; other=1`, /x-api-key=\*+/],
			[`accessKeyId: ${S('akid')}`, /\*+/],
			[`AWS_SECRET_ACCESS_KEY=${S('aws')}`, /\*+/],
			[`client_secret=${S('cs')}&grant_type=refresh`, /client_secret=\*+/],
		];
		for (const [input, re] of cases) {
			const out = maskCredentialValues(input);
			assert.deepEqual(leaked(out), [], `${input} -> ${out}`);
			assert.match(out, re, `${input} -> ${out}`);
		}
		// Keys the anchored pattern deliberately leaves: settings, not credentials.
		for (const plain of ['maxTokens: 4096', 'operationTokenTimeout: 1d', 'keyPath: /etc/x', 'tokenizer: gpt']) {
			assert.equal(maskCredentialValues(plain), plain);
		}
	});

	it('P: maskCredentialFile keeps byte length on multi-byte text and masks a credential in a JSON config', () => {
		const json = `{"models":{"generative":{"default":{"apiKey":"${S('json')}-ñ-🙂","model":"m"}}}}`;
		const masked = maskCredentialFile(Buffer.from(json)).toString('utf8');
		assert.deepEqual(leaked(masked), [], masked);
		assert.equal(Buffer.byteLength(masked), Buffer.byteLength(json));
		assert.ok(masked.includes('"model":"m"'));
	});
});
