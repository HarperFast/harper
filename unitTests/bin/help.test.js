'use strict';

const assert = require('node:assert');
const { help } = require('#src/bin/help');
const { wantsTopLevelHelp } = require('#src/bin/harper');
const { SERVICE_ACTIONS_ENUM } = require('#src/utility/hdbTerms');

const USAGE = 'Usage: harperdb [command]';
const OPERATIONS_URL = 'https://docs.harperdb.io/reference/v5/operations-api/operations';
// Every command that must survive in the rendered output; a dropped one is a regression.
const COMMANDS = [
	'start',
	'stop',
	'restart',
	'status',
	'run <path>',
	'dev <path>',
	'deploy',
	'install',
	'upgrade',
	'register',
	'renew-certs',
	'copy-db <source> <target>',
	'version',
	'help',
	'logout [target]',
	'agent [message]',
	'mcp [subcommand]',
];

const maxLineLength = (text) => Math.max(...text.split('\n').map((line) => line.length));

describe('bin/help.ts help()', () => {
	const originalColumns = process.stdout.columns;
	afterEach(() => {
		process.stdout.columns = originalColumns;
	});

	it('caps the width at 120 for wide and non-TTY terminals', () => {
		for (const columns of [500, undefined]) {
			process.stdout.columns = columns;
			assert.ok(
				maxLineLength(help()) <= 120,
				`columns=${columns} should render at most 120 wide, got ${maxLineLength(help())}`
			);
		}
	});

	it('wraps every line to a narrow terminal width', () => {
		process.stdout.columns = 70;
		// 70 is wide enough that even the longest single token (the operations URL) fits, so no line
		// should exceed it once wrapping kicks in.
		for (const line of help().split('\n')) {
			assert.ok(line.length <= 70, `line exceeds 70 columns: ${JSON.stringify(line)}`);
		}
	});

	it('reflows more narrowly as the terminal shrinks', () => {
		process.stdout.columns = 120;
		const wide = help().split('\n').length;
		process.stdout.columns = 70;
		const narrow = help().split('\n').length;
		assert.ok(narrow > wide, `narrower terminal should wrap into more lines (${narrow} vs ${wide})`);
	});

	it('never breaks a URL across lines', () => {
		process.stdout.columns = 70;
		const lines = help().split('\n');
		assert.ok(
			lines.some((line) => line.includes(OPERATIONS_URL)),
			'the operations URL must stay intact on a single line'
		);
	});

	it('aligns the description column across all command sections', () => {
		process.stdout.columns = 120;
		const dashColumns = new Set(
			help()
				.split('\n')
				.filter((line) => /^ {2}\S/.test(line) && line.includes(' - '))
				.map((line) => line.indexOf(' - '))
		);
		assert.strictEqual(dashColumns.size, 1, `command rows should share one dash column, saw ${[...dashColumns]}`);
	});

	it('renders every command and the usage header', () => {
		process.stdout.columns = 120;
		const output = help();
		assert.ok(output.includes(USAGE), 'missing usage header');
		for (const command of COMMANDS) {
			assert.ok(output.includes(command), `missing command in help output: ${command}`);
		}
	});
});

describe('bin/harper.ts wantsTopLevelHelp()', () => {
	// argv[2] is the service; harper() lowercases it before calling, so pass it through as `service`.
	const argv = (...args) => ['node', 'harper', ...args];

	for (const flag of ['-h', '--help']) {
		it(`triggers on a bare ${flag}`, () => {
			assert.strictEqual(wantsTopLevelHelp(argv(flag), undefined), true);
		});
	}

	it("triggers on 'start --help' (flag wins before the command runs, so it never starts the server)", () => {
		assert.strictEqual(wantsTopLevelHelp(argv(SERVICE_ACTIONS_ENUM.START, '--help'), SERVICE_ACTIONS_ENUM.START), true);
	});

	it('defers to subcommands that own their own --help', () => {
		for (const service of [SERVICE_ACTIONS_ENUM.MCP, SERVICE_ACTIONS_ENUM.AGENT, SERVICE_ACTIONS_ENUM.CHAT]) {
			assert.strictEqual(wantsTopLevelHelp(argv(service, '--help'), service), false, `${service} should own --help`);
			assert.strictEqual(wantsTopLevelHelp(argv(service, '-h'), service), false, `${service} should own -h`);
		}
	});

	it('does not trigger without a help flag', () => {
		assert.strictEqual(wantsTopLevelHelp(argv(SERVICE_ACTIONS_ENUM.STATUS), SERVICE_ACTIONS_ENUM.STATUS), false);
		assert.strictEqual(wantsTopLevelHelp(argv(), undefined), false);
	});

	it('matches only a bare -h/--help token, not an operation param that contains it', () => {
		// operations use key=value, so a value with the substring must not be mistaken for the flag
		assert.strictEqual(wantsTopLevelHelp(argv('add_user', 'role=--help'), 'add_user'), false);
	});
});
