'use strict';

// Credential helper for private git-reference deploys (#1792), executed by git as a child process.
//
// It holds no secret. The token lives only in the deploying Harper process's memory; this script
// asks for it over the per-deploy socket named by HARPER_GIT_CREDENTIAL_SOCKET (see
// gitCredentialServer.ts) and writes the answer to stdout for git to consume. Nothing is written to
// disk, and the token never appears in argv or in this process's environment.
//
// git invokes it two ways, so it answers both:
//   - as a `credential.helper` (git >= 2.31, wired up via GIT_CONFIG_*): the operation
//     (`get`/`store`/`erase`) is the last argument and the request is key=value lines on stdin.
//   - as GIT_ASKPASS (every git version): the prompt is the first argument.
// Only `get` yields anything; `store`/`erase` are deliberate no-ops, since persisting the
// credential is exactly what this design exists to avoid.

const net = require('node:net');

const socketPath = process.env.HARPER_GIT_CREDENTIAL_SOCKET;

function ask(request) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		socket.setEncoding('utf8');
		let response = '';
		socket.on('error', reject);
		socket.on('connect', () => socket.end(JSON.stringify(request)));
		socket.on('data', (chunk) => (response += chunk));
		socket.on('close', () => {
			try {
				resolve(response ? JSON.parse(response) : {});
			} catch (error) {
				reject(error);
			}
		});
	});
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let input = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => (input += chunk));
		process.stdin.on('error', reject);
		process.stdin.on('end', () => resolve(input));
	});
}

// git's credential protocol: `key=value` lines terminated by a blank line.
function parseCredentialRequest(input) {
	const request = {};
	for (const line of input.split('\n')) {
		const separator = line.indexOf('=');
		if (separator > 0) request[line.slice(0, separator)] = line.slice(separator + 1).replace(/\r$/, '');
	}
	return request;
}

/**
 * Interpret a GIT_ASKPASS prompt, e.g. `Username for 'https://github.com': ` or
 * `Password for 'https://x-access-token@github.com': `.
 *
 * The leading words are localized, so which of the two prompts this is has to be decided
 * structurally rather than by matching English: git only asks for a password once it has a
 * username, and it embeds that username in the URL it echoes back. Userinfo present therefore means
 * the password prompt; absent means the username prompt.
 */
function parseAskpassPrompt(prompt) {
	const quoted = /'([^']+)'/.exec(prompt);
	if (!quoted) return null;
	// url.username can carry a malformed percent-encoding sequence (e.g. from a redirect or a
	// misconfigured remote), which makes decodeURIComponent throw a URIError — keep that inside the
	// same try as the URL parse so it can't crash this process instead of just declining to answer.
	try {
		const url = new URL(quoted[1]);
		return {
			field: url.username ? 'password' : 'username',
			protocol: url.protocol.replace(/:$/, ''),
			host: url.host,
			username: url.username ? decodeURIComponent(url.username) : undefined,
		};
	} catch {
		return null;
	}
}

async function main() {
	if (!socketPath) return; // no session for this spawn: stay silent so git falls through unauthenticated

	const args = process.argv.slice(2);
	const operation = args[args.length - 1];

	if (operation === 'get') {
		const request = parseCredentialRequest(await readStdin());
		const credential = await ask({ protocol: request.protocol, host: request.host, username: request.username });
		if (!credential.password) return;
		process.stdout.write(`username=${credential.username}\npassword=${credential.password}\n`);
		return;
	}
	if (operation === 'store' || operation === 'erase') return;

	const prompt = parseAskpassPrompt(args[0] ?? '');
	if (!prompt) return;
	const credential = await ask(prompt);
	if (!credential.password) return;
	process.stdout.write(`${prompt.field === 'username' ? credential.username : credential.password}\n`);
}

main().catch((error) => {
	// Never leak request detail to git's stderr, which npm surfaces in deploy output. Exiting
	// non-zero makes git treat the credential as unavailable and fail (GIT_TERMINAL_PROMPT=0
	// prevents it from falling back to an interactive prompt).
	process.stderr.write(`harper git credential helper failed: ${error.message}\n`);
	process.exitCode = 1;
});
