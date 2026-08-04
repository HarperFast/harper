/**
 * The `harper help` / `harper -h` output, kept as structured data so {@link help} can render it to
 * the current terminal width (capped at 120 columns) at call time. Content lives separately from
 * layout: editing the text can't break the wrapping, command names stay column-aligned across
 * sections, and the CI/CD sample stays a verbatim, copy-pasteable line at any width.
 */

const MAX_WIDTH = 120;
const INDENT = 2; // leading spaces for command names and detail blocks
const DASH = ' - '; // separator between a command name and its description

/** A paragraph of prose, reflowed to the target width at `indent` spaces. */
interface TextBlock {
	text: string;
	indent?: number;
}

/** A verbatim line (a code sample); never joined or wrapped so it stays copy-pasteable. */
interface PreBlock {
	pre: string;
	indent?: number;
}

/** A two-column list of `[name, description]` rows; descriptions wrap with a hanging indent. */
interface CommandsBlock {
	commands: [name: string, description: string][];
}

type Block = TextBlock | PreBlock | CommandsBlock;

interface Section {
	heading?: string;
	blocks: Block[];
}

const SECTIONS: Section[] = [
	{ blocks: [{ text: 'Usage: harperdb [command]' }] },
	{ blocks: [{ text: 'With no command, harper will simply run Harper (in the foreground)' }] },
	{ blocks: [{ text: 'Documentation: https://docs.harperdb.io/' }] },
	{
		blocks: [
			{
				text: [
					'By default, the CLI also supports certain Operation APIs. Specify the operation name and any required',
					"parameters, and omit the 'operation' command.",
				].join(' '),
			},
		],
	},
	{ blocks: [{ text: 'Commands:' }] },
	{
		heading: 'Server',
		blocks: [
			{
				commands: [
					['start', 'Starts a separate background process for harperdb and CLI will exit'],
					['stop', 'Stop the harperdb background process'],
					['restart', 'Restart the harperdb background process'],
					['status', 'Print the status of Harper'],
				],
			},
		],
	},
	{
		heading: 'Applications',
		blocks: [
			{
				commands: [
					['run <path>', 'Run the application in the specified path'],
					['dev <path>', 'Run the application in dev mode with debugging, foreground logging, no auth'],
					['deploy', 'Deploy the application locally or remotely with target=<remote url>'],
				],
			},
		],
	},
	{
		heading: 'Install & maintenance',
		blocks: [
			{
				commands: [
					['install', 'Install harperdb'],
					['upgrade', 'Upgrade harperdb'],
					['register', 'Register harperdb'],
					['renew-certs', 'Generate a new set of self-signed certificates'],
					['copy-db <source> <target>', 'Copies a database from source path to target path'],
					['version', 'Print the version'],
					['help', 'Display this output'],
				],
			},
		],
	},
	{
		heading: 'Accounts',
		blocks: [
			{ pre: 'login [target] [username]', indent: INDENT },
			{
				text: [
					'Login to a remote or local Harper instance. --for-ci prints the CI/CD credentials (target +',
					'long-lived refresh token) to stdout in dotenv format, and everything else to stderr, so it pipes',
					'without the token hitting your screen:',
				].join(' '),
				indent: 4,
			},
			{ pre: 'harper login --for-ci | gh secret set --env-file -', indent: 6 },
			{
				text: [
					'Log in as a user dedicated to that one CI consumer: Harper stores a single refresh token per user, so',
					'this revokes any refresh token that user already holds — another runner, another machine, or an earlier',
					"'harper login' will 401 on its next refresh. Two consumers cannot share a user.",
				].join(' '),
				indent: 4,
			},
			{ commands: [['logout [target]', 'Logout from Harper and clear saved JWT']] },
		],
	},
	{
		heading: 'Assistants',
		blocks: [
			{
				commands: [
					['agent [message]', 'Chat with the built-in agent (interactive, or one-shot with a message; alias: chat)'],
					['mcp [subcommand]', "MCP stdio bridge / print-config / doctor (see 'harper mcp help')"],
				],
			},
		],
	},
	{
		heading: 'Operations API',
		blocks: [
			{ pre: '<api-operation> <param>=<value>', indent: INDENT },
			{
				text: [
					'Run an API operation and return the result to the CLI (not all operations are supported). See the full',
					'list of operations at: https://docs.harperdb.io/reference/v5/operations-api/operations',
				].join(' '),
				indent: 4,
			},
			{
				text: [
					'To authenticate as a different user than the one being operated on (e.g. add_user/alter_user), set',
					"HARPER_CLI_USERNAME/HARPER_CLI_PASSWORD or run 'harper login'. The equivalent auth_username=<value>",
					'auth_password=<value> args also work, but a password passed as an argument is exposed in shell',
					'history, process listings and CI logs. A saved login token always outranks username=/password=, so a',
					"stale token that fails to refresh will 401 rather than falling back to them — run 'harper logout' or",
					'pass auth_username=/auth_password= to override it.',
				].join(' '),
				indent: 4,
			},
		],
	},
];

const pad = (count: number): string => ' '.repeat(count);

/** Greedy word wrap. Never splits a token, so URLs and flags survive intact (they overflow). */
function wrap(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const lines: string[] = [];
	let line = words[0];
	for (let i = 1; i < words.length; i++) {
		if (line.length + 1 + words[i].length > width) {
			lines.push(line);
			line = words[i];
		} else {
			line += ' ' + words[i];
		}
	}
	lines.push(line);
	return lines;
}

function renderBlock(block: Block, width: number, nameWidth: number, descCol: number): string[] {
	if ('commands' in block) {
		return block.commands.flatMap(([name, description]) => {
			const wrapped = wrap(description, Math.max(1, width - descCol));
			const head = pad(INDENT) + name.padEnd(nameWidth) + DASH;
			return [head + (wrapped[0] ?? ''), ...wrapped.slice(1).map((line) => pad(descCol) + line)];
		});
	}
	if ('pre' in block) return [pad(block.indent ?? 0) + block.pre];
	const indent = block.indent ?? 0;
	return wrap(block.text, Math.max(1, width - indent)).map((line) => pad(indent) + line);
}

/** Render the CLI help, wrapped to the terminal width (capped at 120, and 120 when not a TTY). */
export function help(): string {
	const width = Math.min(process.stdout.columns || MAX_WIDTH, MAX_WIDTH);

	// One shared description column across every command list so names line up between sections,
	// driven by the longest command name.
	const names = SECTIONS.flatMap((section) =>
		section.blocks.flatMap((block) => ('commands' in block ? block.commands.map(([name]) => name) : []))
	);
	const nameWidth = Math.max(...names.map((name) => name.length));
	const descCol = INDENT + nameWidth + DASH.length;

	const lines: string[] = [];
	for (const section of SECTIONS) {
		if (lines.length) lines.push(''); // blank line between sections
		if (section.heading) lines.push(section.heading);
		for (const block of section.blocks) lines.push(...renderBlock(block, width, nameWidth, descCol));
	}
	return '\n' + lines.join('\n') + '\n';
}
