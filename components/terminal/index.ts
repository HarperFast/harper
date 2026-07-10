/**
 * Built-in interactive terminal (PROTOTYPE — for team review).
 *
 * Exposes a super_user-only PTY over a WebSocket on the **operations API port**,
 * so Studio can render an xterm.js terminal that runs *inside* the instance
 * container. Living on the operations port (not the application data port) keeps
 * the terminal on the same security boundary as the rest of the operations
 * surface. This is the stepping-stone channel from the "Claude in the container"
 * design; the authenticated WebSocket it establishes is the substrate the
 * planned live-log-stream and inspector-bridge features will reuse.
 *
 * Wired in from `server/operationsServer.ts` (main thread), alongside the MCP
 * operations profile: `registerTerminalWebSocket({ nodeServer, config })`
 * attaches a `/terminal` upgrade handler to the operations Fastify server's
 * underlying Node server. There is no `handleApplication` and no worker-thread
 * registration — the operations port is main-thread only.
 *
 * AUTH is FIRST-MESSAGE (no change to `security/auth.ts`): the socket is
 * accepted unauthenticated, and the client's first frame carries the credential
 * (`a{"token":...}` or `a{"username":...,"password":...}`). We validate it and
 * assert super_user before spawning anything. Nothing sensitive rides in the
 * handshake headers/subprotocol (which intermediaries may log).
 *
 * WIRE PROTOCOL (mirror of studio `src/features/instance/terminal/wire.ts`):
 *   client -> server (text frames, first char is an opcode):
 *     'a<json>'  auth — MUST be first. `{ token }` or `{ username, password }`.
 *     'i<data>'  stdin — bytes after the opcode are written to the PTY
 *     'r<json>'  resize — JSON `{ cols, rows }`
 *   server -> client:
 *     raw PTY output as text frames (no opcode)
 *     close(code, reason): 4401 unauth, 4403 not super_user, 4408 idle/auth
 *     timeout, 4429 session limit, 4500 backend error, 1000 shell exit
 *
 * PROTOTYPE CAVEATS (call out in review):
 *   - `node-pty` is a native addon and an optional dependency; dynamically
 *     imported so a build without it degrades to a clear runtime error. Ships in
 *     the trusted cloud image, so the native build is controlled by us.
 *   - The PTY runs on the operations (main) thread and inherits its privileges;
 *     no per-user resource accounting beyond a global session cap. Deliberate
 *     scoping for a prototype — production wants cgroups/user-namespacing.
 */
import { WebSocketServer } from 'ws';
import { forComponent as loggerForComponent } from '../../utility/logging/harper_logger.ts';
import { validateOperationToken } from '../../security/tokenAuthentication.ts';
import { server } from '../../server/Server.ts';

const terminalLog = loggerForComponent('terminal');

/** Subprotocol used to identify a terminal upgrade (carries no credential). */
const TERMINAL_SUBPROTOCOL = 'harper-terminal';
/** Path the terminal upgrade handler listens on. */
const TERMINAL_WS_PATH = '/terminal';

/** Client->server opcodes (first character of each text frame). */
const OPCODE_AUTH = 'a';
const OPCODE_INPUT = 'i';
const OPCODE_RESIZE = 'r';

/** Milliseconds to wait for the first-message auth frame before closing. */
const AUTH_TIMEOUT_MS = 5000;

interface TerminalConfig {
	enabled?: boolean;
	shell?: string;
	args?: string[];
	cwd?: string;
	idleTimeoutMs?: number;
	maxSessions?: number;
}

const DEFAULTS = {
	idleTimeoutMs: 10 * 60 * 1000,
	maxSessions: 10,
};

/** Live PTY count on this (main) thread, enforced against maxSessions. */
let liveSessions = 0;

/** Loaded lazily on first authenticated connection. */
let ptyModule: any = null;
async function loadPty(): Promise<any> {
	if (!ptyModule) ptyModule = await import('node-pty');
	return ptyModule;
}

let registered = false;

interface RegisterArgs {
	/** The operations Fastify server's underlying Node HTTP(S) server (`app.server`). */
	nodeServer: import('node:http').Server;
	/** The `terminal` config block from the merged root config. */
	config: TerminalConfig;
}

/**
 * Attach the `/terminal` WebSocket upgrade handler to the operations node
 * server. Called once, from `server/operationsServer.ts`, only when
 * `terminal.enabled === true`.
 */
export function registerTerminalWebSocket({ nodeServer, config }: RegisterArgs): void {
	if (registered) return;
	if (config?.enabled !== true) {
		terminalLog.info?.('terminal.enabled !== true; not registering the terminal WebSocket');
		return;
	}
	registered = true;

	const shell = config.shell || process.env.SHELL || 'bash';
	const shellArgs = config.args ?? [];
	const cwd = config.cwd || process.env.HDB_ROOT || process.cwd();
	const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
	const maxSessions = config.maxSessions ?? DEFAULTS.maxSessions;

	// Dedicated WS server so we own subprotocol negotiation and don't disturb the
	// app-port WS server. `noServer` because we drive handleUpgrade ourselves.
	const wss = new WebSocketServer({
		noServer: true,
		// Bound frame size so a client can't exhaust memory with a huge frame.
		maxPayload: 1024 * 1024,
		handleProtocols: (protocols: Set<string>) => (protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false),
	});
	// A ws.Server is an EventEmitter: an unhandled 'error' event throws and would
	// crash the process, so always attach a listener.
	wss.on('error', (error) => terminalLog.error?.('terminal WebSocketServer error', error));

	nodeServer.on('upgrade', (req, socket, head) => {
		let pathname: string;
		try {
			pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
		} catch {
			return;
		}
		// Only handle our path; leave any other upgrade for other listeners.
		if (pathname !== TERMINAL_WS_PATH) return;

		wss.handleUpgrade(req, socket as any, head, (ws) => {
			void onTerminalConnection(ws, req, { shell, shellArgs, cwd, idleTimeoutMs, maxSessions });
		});
	});

	terminalLog.info?.(
		`terminal WebSocket registered at ${TERMINAL_WS_PATH} on the operations port (shell=${shell}, maxSessions=${maxSessions})`
	);
}

interface SessionOptions {
	shell: string;
	shellArgs: string[];
	cwd: string;
	idleTimeoutMs: number;
	maxSessions: number;
}

async function authenticate(payload: string, req: any): Promise<any | null> {
	let auth: any;
	try {
		auth = JSON.parse(payload);
	} catch {
		return null;
	}
	if (auth?.token) {
		try {
			return await validateOperationToken(auth.token);
		} catch {
			return null;
		}
	}
	if (auth?.username) {
		try {
			// server.authenticateUser expects (username, password, request) — pass req
			// through so the auth provider gets its usual context (audit, ip, etc.).
			return await (server as any).authenticateUser(auth.username, auth.password ?? '', req);
		} catch {
			return null;
		}
	}
	return null;
}

async function onTerminalConnection(ws: any, req: any, opts: SessionOptions): Promise<void> {
	const remote = req?.socket?.remoteAddress ?? 'unknown';
	let authed = false;
	let authenticating = false;
	let term: any = null;
	let closed = false;
	let idleTimer: NodeJS.Timeout | undefined;

	const authTimer = setTimeout(() => {
		if (!authed) {
			terminalLog.warn?.(`terminal AUTH-TIMEOUT from ${remote}`);
			safeClose(ws, 4408, 'auth timeout');
		}
	}, AUTH_TIMEOUT_MS);
	authTimer.unref?.();

	const resetIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			terminalLog.info?.(`terminal IDLE-CLOSE from ${remote}`);
			safeClose(ws, 4408, 'idle timeout');
		}, opts.idleTimeoutMs);
		idleTimer.unref?.();
	};

	const teardown = (reason: string) => {
		if (closed) return;
		closed = true;
		clearTimeout(authTimer);
		if (idleTimer) clearTimeout(idleTimer);
		if (term) {
			try {
				term.kill();
			} catch {
				/* already gone */
			}
			liveSessions = Math.max(0, liveSessions - 1);
			terminalLog.notify?.(`terminal CLOSE from ${remote} (reason=${reason}, live=${liveSessions})`);
		}
	};

	ws.on('message', async (raw: Buffer | string) => {
		const frame = typeof raw === 'string' ? raw : raw.toString('utf8');
		if (frame.length === 0) return;
		const opcode = frame[0];
		const payload = frame.slice(1);

		if (!authed) {
			// The message handler is async: a client could fire several auth frames
			// before the first resolves. `authenticating` is set synchronously (before
			// any await) so re-entrant frames bail out instead of spawning a 2nd PTY.
			if (authenticating || opcode !== OPCODE_AUTH) {
				safeClose(ws, 4401, 'authentication required');
				return;
			}
			authenticating = true;
			const user = await authenticate(payload, req);
			// The socket may have closed during the await (e.g. a second rapid auth
			// frame triggered safeClose → teardown). Bail before reserving a slot or
			// spawning, or we'd leak liveSessions and orphan a PTY on a dead socket.
			if (closed) return;
			const username = user?.username ?? 'anonymous';
			if (!user) {
				terminalLog.warn?.(`terminal AUTH-FAIL from ${remote}`);
				safeClose(ws, 4401, 'invalid credentials');
				return;
			}
			if (!user.role?.permission?.super_user) {
				terminalLog.warn?.(`terminal DENIED for '${username}' from ${remote} (super_user required)`);
				safeClose(ws, 4403, 'super_user required');
				return;
			}
			// Reserve the session slot synchronously (check + increment with no await
			// between them) so concurrent connections can't both pass the check and
			// overshoot maxSessions. Rolled back below if PTY startup fails.
			if (liveSessions >= opts.maxSessions) {
				terminalLog.warn?.(`terminal REJECTED for '${username}' from ${remote} (maxSessions reached)`);
				safeClose(ws, 4429, 'terminal session limit reached');
				return;
			}
			liveSessions++;

			let pty: any;
			try {
				pty = await loadPty();
			} catch (error) {
				liveSessions = Math.max(0, liveSessions - 1);
				terminalLog.error?.('node-pty unavailable; install it in the instance image', error);
				safeClose(ws, 4500, 'terminal backend (node-pty) not installed');
				return;
			}
			// Socket may have closed during the loadPty() import — roll back the
			// reserved slot and don't spawn onto a dead socket.
			if (closed) {
				liveSessions = Math.max(0, liveSessions - 1);
				return;
			}
			try {
				term = pty.spawn(opts.shell, opts.shellArgs, {
					name: 'xterm-color',
					cols: 80,
					rows: 24,
					cwd: opts.cwd,
					env: process.env,
				});
			} catch (error) {
				liveSessions = Math.max(0, liveSessions - 1);
				terminalLog.error?.(`failed to spawn shell '${opts.shell}'`, error);
				safeClose(ws, 4500, 'failed to spawn shell');
				return;
			}

			authed = true;
			clearTimeout(authTimer);
			resetIdle();
			terminalLog.notify?.(`terminal OPEN for '${username}' from ${remote} (pid=${term.pid}, live=${liveSessions})`);

			term.onData((data: string) => {
				resetIdle();
				try {
					ws.send(data);
				} catch {
					teardown('send-failed');
				}
			});
			term.onExit(({ exitCode }: { exitCode: number }) => {
				teardown(`shell-exit(${exitCode})`);
				safeClose(ws, 1000, `shell exited (${exitCode})`);
			});
			return;
		}

		// Authenticated frames. The socket can still deliver messages during the
		// WS close handshake after the PTY exited, so bail if we're tearing down.
		if (closed || !term) return;
		resetIdle();
		if (opcode === OPCODE_INPUT) {
			try {
				term.write(payload);
			} catch {
				teardown('write-failed');
			}
		} else if (opcode === OPCODE_RESIZE) {
			try {
				const { cols, rows } = JSON.parse(payload);
				if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
					term.resize(cols, rows);
				}
			} catch {
				/* ignore malformed resize */
			}
		}
	});

	ws.on('close', () => teardown('ws-close'));
	ws.on('error', (error: Error) => {
		terminalLog.info?.(`terminal ws error from ${remote}`, error);
		teardown('ws-error');
	});
}

function safeClose(ws: any, code: number, reason: string): void {
	try {
		ws.close(code, reason);
	} catch {
		/* socket already gone */
	}
}
