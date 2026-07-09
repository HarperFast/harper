/**
 * `harper agent` — a thin CLI client for the built-in agent (#626).
 *
 * Drives the agent operations API (`agent_prompt`, `get_agent_session`,
 * `approve_agent_action`, …) over the operations transport that the rest of the
 * CLI already uses: a local unix domain socket by default, or a remote target
 * (`--target`, stored `harper login` tokens, or env credentials). Two modes:
 *   - one-shot: `harper agent "build me a Product table"` → prints the reply and exits.
 *   - interactive: `harper agent` → a REPL; each line is a turn on one session.
 *
 * Rendering is a simple transcript delta: after each prompt we poll the session
 * and print only the items appended since the last poll (assistant text, tool
 * calls and their results). On `awaiting_approval` we prompt the operator to
 * approve or deny each pending tool call, then resume.
 */

import * as readline from 'node:readline';
import { loadCredentials, normalizeTarget } from './cliCredentials.ts';
import { httpRequest } from '../utility/common_utils.ts';
import { getHdbPid } from '../utility/processManagement/processManagement.js';
import { initConfig, getConfigPath } from '../config/configUtils.ts';
import * as terms from '../utility/hdbTerms.ts';

const POLL_INTERVAL_MS = 1000;
const TERMINAL_STATUSES = new Set(['completed', 'error', 'idle', 'aborted']);

interface CliOptions {
	target?: string;
	username?: string;
	password?: string;
	session?: string;
	json: boolean;
	once: boolean;
	message?: string;
}

interface Connection {
	options: any;
	label: string;
}

const HELP = `harper agent — interact with the built-in Harper agent

Usage:
  harper agent [message]              Send a prompt (one-shot) and print the reply
  harper agent                        Start an interactive session (REPL)

Options:
  --target <url>       Remote Harper ops API (e.g. https://host:9925). Defaults to the local instance.
  --username <user>    Username (or HARPER_CLI_USERNAME). Super-user required.
  --password <pass>    Password (or HARPER_CLI_PASSWORD).
  --session <id>       Resume an existing agent session.
  --json               Print the raw session JSON instead of a rendered transcript.
  --once               Force one-shot mode (read a single prompt from stdin if no message given).
  -h, --help           Show this help.

In interactive mode: /new resets the session, /exit (or Ctrl-D) quits, /help shows commands.`;

export async function runAgentCli(argv: string[]): Promise<number> {
	const opts = parseArgs(argv);
	if ((opts as any).help) {
		console.log(HELP);
		return 0;
	}

	let connection: Connection;
	try {
		connection = resolveConnection(opts);
	} catch (err) {
		console.error((err as Error).message);
		return 1;
	}

	const client = new AgentClient(connection, opts);
	try {
		if (opts.message !== undefined) {
			await client.runOnce(opts.message);
		} else if (opts.once || !process.stdin.isTTY) {
			// Piped input / --once: treat all of stdin as a single prompt.
			const piped = await readAllStdin();
			if (!piped.trim()) {
				console.error('No prompt provided.');
				return 1;
			}
			await client.runOnce(piped.trim());
		} else {
			await client.repl();
		}
		return 0;
	} catch (err) {
		console.error(`agent: ${(err as Error).message}`);
		return 1;
	}
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = { json: false, once: false };
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case '-h':
			case '--help':
				(opts as any).help = true;
				break;
			case '--json':
				opts.json = true;
				break;
			case '--once':
				opts.once = true;
				break;
			case '--target':
				opts.target = argv[++i];
				break;
			case '--username':
			case '--user':
				opts.username = argv[++i];
				break;
			case '--password':
			case '--pass':
				opts.password = argv[++i];
				break;
			case '--session':
				opts.session = argv[++i];
				break;
			default:
				if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
				else if (a.startsWith('--session=')) opts.session = a.slice('--session='.length);
				else if (!a.startsWith('-')) words.push(a);
				break;
		}
	}
	if (words.length) opts.message = words.join(' ');
	return opts;
}

/**
 * Resolve the operations-API connection: a remote target (flag/env/stored last_target) with Basic
 * or Bearer auth, else the local domain socket. Mirrors the core of `cliOperations` without the
 * deploy-specific transport concerns.
 */
function resolveConnection(opts: CliOptions): Connection {
	const credentials = loadCredentials();
	const rawTarget =
		opts.target || process.env.HARPER_CLI_TARGET || process.env.CLI_TARGET || (credentials && credentials.last_target);

	if (rawTarget) {
		const resolved = normalizeTarget(rawTarget);
		let url: URL;
		try {
			url = new URL(resolved);
		} catch {
			// Bare host[:port] with no protocol — only append the default port when one isn't already present.
			const withPort = rawTarget.includes(':') ? rawTarget : `${rawTarget}:9925`;
			url = new URL(`https://${withPort}`);
		}
		const username =
			opts.username || url.username || process.env.HARPER_CLI_USERNAME || process.env.CLI_TARGET_USERNAME || '';
		const password =
			opts.password || url.password || process.env.HARPER_CLI_PASSWORD || process.env.CLI_TARGET_PASSWORD || '';
		const options: any = {
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		};
		if (opts.username || opts.password || url.username) {
			options.headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
		} else {
			const tokens = credentials?.targets?.[resolved];
			if (tokens?.operation_token) {
				options.headers.Authorization = `Bearer ${tokens.operation_token}`;
			} else if (username) {
				options.headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
			} else {
				throw new Error(
					`No credentials for ${resolved}. Run \`harper login ${resolved}\` or pass --username/--password.`
				);
			}
		}
		return { options, label: resolved };
	}

	// Local instance over the operations domain socket.
	initConfig();
	if (!getHdbPid()) throw new Error('Harper must be running to use the agent (no local instance detected).');
	const socketPath = getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET);
	if (!socketPath) throw new Error('No operations domain socket configured for the local instance.');
	return {
		options: { protocol: 'http:', socketPath, method: 'POST', headers: { 'Content-Type': 'application/json' } },
		label: 'local',
	};
}

class AgentClient {
	private connection: Connection;
	private opts: CliOptions;
	private sessionId?: string;
	private printed = 0; // number of transcript items already rendered

	constructor(connection: Connection, opts: CliOptions) {
		this.connection = connection;
		this.opts = opts;
		this.sessionId = opts.session;
	}

	private async send(operation: string, extra: Record<string, unknown> = {}): Promise<any> {
		const response = await httpRequest(this.connection.options, { operation, ...extra });
		const status = (response as any).statusCode;
		let parsed: any;
		try {
			parsed = JSON.parse((response as any).body || '{}');
		} catch {
			throw new Error(`Non-JSON response (HTTP ${status}): ${((response as any).body || '').slice(0, 200)}`);
		}
		if (status && status >= 400) {
			throw new Error(parsed?.error || parsed?.message || `operation ${operation} failed (HTTP ${status})`);
		}
		return parsed;
	}

	async runOnce(message: string): Promise<void> {
		await this.turn(message);
	}

	async repl(): Promise<void> {
		console.error(`Connected to ${this.connection.label}. Type a message, /new to reset, /exit to quit.`);
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		// Ctrl-D / EOF closes the interface without ever invoking a pending question() callback; resolve
		// the outstanding prompt with /exit so the loop unwinds cleanly instead of hanging.
		let resolvePending: ((value: string) => void) | null = null;
		rl.on('close', () => {
			if (resolvePending) {
				resolvePending('/exit');
				resolvePending = null;
			}
		});
		const ask = (q: string) =>
			new Promise<string>((res) => {
				resolvePending = res;
				rl.question(q, (answer) => {
					resolvePending = null;
					res(answer);
				});
			});
		try {
			for (;;) {
				const line = (await ask('\nyou › ')).trim();
				if (line === '') continue;
				if (line === '/exit' || line === '/quit') break;
				if (line === '/help') {
					console.log(HELP);
					continue;
				}
				if (line === '/new') {
					this.sessionId = undefined;
					this.printed = 0;
					console.error('(started a new session)');
					continue;
				}
				try {
					await this.turn(line, rl);
				} catch (err) {
					console.error(`agent: ${(err as Error).message}`);
				}
			}
		} finally {
			rl.close();
		}
	}

	/** Send one prompt and stream the resulting transcript delta, resolving approvals as needed. */
	private async turn(message: string, rl?: readline.Interface): Promise<void> {
		const started = await this.send('agent_prompt', {
			...(this.sessionId ? { session_id: this.sessionId } : {}),
			message,
		});
		if (!this.sessionId) {
			this.sessionId = started.session_id;
			this.printed = 1; // the user message we just sent is item 0
		}
		await this.pollUntilIdle(rl);
	}

	private async pollUntilIdle(rl?: readline.Interface): Promise<void> {
		for (;;) {
			const session = await this.send('get_agent_session', { session_id: this.sessionId });
			if (!session) throw new Error('Failed to retrieve agent session.');
			if (!this.opts.json) this.renderDelta(session);
			const status = session.status;
			if (status === 'awaiting_approval') {
				// Only emit the raw session once we actually pause, not on every poll interval.
				if (this.opts.json) console.log(JSON.stringify(session, null, 2));
				const resolvedAny = await this.resolveApprovals(session, rl);
				if (!resolvedAny) return; // nothing actionable / operator declined to act
				continue; // resuming — poll again
			}
			if (TERMINAL_STATUSES.has(status)) {
				if (this.opts.json) console.log(JSON.stringify(session, null, 2));
				return;
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	private renderDelta(session: any): void {
		const items: any[] = session.messages || [];
		for (let i = this.printed; i < items.length; i++) {
			const m = items[i];
			if (!m) continue;
			if (m.role === 'assistant') {
				if (m.content) console.log(`\nagent › ${m.content}`);
				for (const tc of m.toolCalls || []) {
					console.log(`  ▸ ${tc.name}(${summarize(tc.arguments)})`);
				}
			} else if (m.role === 'tool') {
				console.log(`  ⤷ ${summarize(m.content)}`);
			}
		}
		this.printed = items.length;
	}

	/** Prompt the operator for each unresolved approval and submit the decisions. Returns true if any were resolved. */
	private async resolveApprovals(session: any, rl?: readline.Interface): Promise<boolean> {
		const pending = (session.pendingApprovals || []).filter((a: any) => a && !a.resolved);
		if (!pending.length) return false;
		// One-shot/piped paths have already read stdin to EOF (or there is no TTY), so a fresh readline
		// on process.stdin would never resolve `question()` and the turn would hang forever. Fail loudly.
		if (!rl && !process.stdin.isTTY) {
			throw new Error(
				'Tool approval required, but no interactive terminal is available; re-run interactively to approve.'
			);
		}
		const ownRl = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
		const ask = (q: string) => new Promise<string>((res) => ownRl.question(q, res));
		try {
			let resolvedAny = false;
			for (const a of pending) {
				console.log(`\n⚠ approval required: ${a.toolName}(${summarize(a.arguments)})  [reason: ${a.reason}]`);
				const answer = (await ask('  approve? [y/N] ')).trim().toLowerCase();
				const approved = answer === 'y' || answer === 'yes';
				await this.send('approve_agent_action', {
					session_id: this.sessionId,
					approval_id: a.id,
					approved,
				});
				console.error(approved ? '  approved.' : '  denied.');
				resolvedAny = true;
			}
			return resolvedAny;
		} finally {
			if (!rl) ownRl.close();
		}
	}
}

function summarize(value: unknown, max = 160): string {
	let s: string;
	if (typeof value === 'string') s = value;
	else {
		try {
			s = JSON.stringify(value);
		} catch {
			s = String(value);
		}
	}
	s = (s ?? '').replace(/\s+/g, ' ');
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

function readAllStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => (data += chunk));
		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}
