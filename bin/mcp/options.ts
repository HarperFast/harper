/**
 * Argument and environment resolution for `harper mcp`. The CLI deliberately
 * avoids pulling in a flag-parsing dep (Harper's no-new-deps policy) — a few
 * `--key=value` and `--key value` arguments plus a positional subcommand is
 * the entire vocabulary.
 *
 * Two connection modes:
 *   - **UDS** (default): connects to the locally-running Harper instance via
 *     the operationsApi domain socket. **Only the operations profile is
 *     reachable this way** — the application profile is mounted on the
 *     application HTTP server, which doesn't expose a UDS in v1. Filesystem
 *     permissions on the operations socket are the access gate; no
 *     credentials are required or sent.
 *   - **HTTPS**: `--target https://host:port` connects over the network.
 *     Required for `--profile application`. Credential precedence
 *     (highest first):
 *       `--bearer` > `--username` + `--password` > URL-embedded user/pass
 *       > saved JWT from `~/.harperdb/credentials.json` (populated by
 *       `harper login` and looked up via `cliCredentials.normalizeTarget`).
 */

export interface McpCliOptions {
	subcommand: 'bridge' | 'print-config' | 'doctor' | 'help';
	profile: 'operations' | 'application';
	target?: string;
	mountPath: string;
	username?: string;
	password?: string;
	bearer?: string;
	rejectUnauthorized: boolean;
	client?: 'claude-desktop' | 'cursor' | 'zed';
	help: boolean;
}

export function parseArgs(argv: readonly string[]): McpCliOptions {
	const opts: McpCliOptions = {
		subcommand: 'bridge',
		// Operations is the safer default: the typical zero-config path
		// (`harper mcp` / `harper mcp doctor` on the local machine, no
		// --target) connects over the operations UDS, which only routes
		// to the operations MCP endpoint in v1.
		profile: 'operations',
		mountPath: '/mcp',
		rejectUnauthorized: true,
		help: false,
	};

	// argv begins after `harper mcp`, i.e. process.argv.slice(3).
	let i = 0;
	if (argv[0] && !argv[0].startsWith('-')) {
		const sub = argv[0];
		if (sub === 'print-config' || sub === 'doctor' || sub === 'help') {
			opts.subcommand = sub;
			i = 1;
		} else if (sub === 'bridge') {
			opts.subcommand = 'bridge';
			i = 1;
		}
		// anything else: assume it's a flag-style arg or noise; leave i=0.
	}

	for (; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.indexOf('=');
		const isLong = arg.startsWith('--');
		const key = isLong ? (eq === -1 ? arg.slice(2) : arg.slice(2, eq)) : arg;
		const valueInline = eq === -1 ? undefined : arg.slice(eq + 1);
		const consumeNext = (): string | undefined => {
			if (valueInline !== undefined) return valueInline;
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('-')) return undefined;
			i++;
			return next;
		};

		switch (key) {
			case '--profile':
			case 'profile': {
				const v = consumeNext();
				if (v === 'operations' || v === 'application') opts.profile = v;
				break;
			}
			case '--target':
			case 'target':
				opts.target = consumeNext();
				break;
			case '--mount-path':
			case 'mount-path':
				opts.mountPath = consumeNext() ?? opts.mountPath;
				break;
			case '--username':
			case 'username':
				opts.username = consumeNext();
				break;
			case '--password':
			case 'password':
				opts.password = consumeNext();
				break;
			case '--bearer':
			case 'bearer':
				opts.bearer = consumeNext();
				break;
			case '--insecure':
			case 'insecure':
				opts.rejectUnauthorized = false;
				break;
			case '--client':
			case 'client': {
				const v = consumeNext();
				if (v === 'claude-desktop' || v === 'cursor' || v === 'zed') opts.client = v;
				break;
			}
			case '--help':
			case 'help':
			case '-h':
				opts.help = true;
				break;
		}
	}

	return opts;
}
