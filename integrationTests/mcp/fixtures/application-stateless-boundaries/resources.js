import { threadId } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

// Optional module-load registrations controlled via environment variables so one fixture covers all suites.
if (process.env.QA_INIT_INSTRUCTIONS) {
	server.setMcpInstructions(process.env.QA_INIT_INSTRUCTIONS);
}
if (process.env.QA_INIT_SERVER_CARD) {
	server.setMcpServerCard(JSON.parse(process.env.QA_INIT_SERVER_CARD));
}

async function recordEvent(kind, data) {
	await tables.QaEvent.put({
		id: randomUUID(),
		kind,
		payload: JSON.stringify(data),
	});
}

function abortableDelay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error('aborted'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error('aborted'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

if (process.env.QA_ENABLE_QUOTA === 'true') {
	server.setMcpQuotaHandler(async (info) => {
		await recordEvent('quota', {
			identity: info.identity ?? null,
			tool: info.tool,
			username: info.user?.username ?? null,
			profile: info.profile,
			hasSessionIdKey: Object.hasOwn(info, 'sessionId'),
			sessionIdIsUndefined: info.sessionId === undefined,
			sessionIdValue: info.sessionId === undefined ? '__UNDEFINED__' : info.sessionId,
		});
		if (info.identity === '10.0.0.99') {
			return { allowed: false, message: 'qa stateless quota exceeded', retryAfterSeconds: 42 };
		}
		return true;
	});
}

export class Health extends Resource {
	static loadAsInstance = false;
	get() {
		return { ok: true, pid: process.pid, threadId };
	}
}

export class SessionTableProbe extends Resource {
	static loadAsInstance = false;
	async get() {
		const rows = [];
		for await (const row of databases.system.mcp_session.search({})) {
			rows.push({
				id: row.id,
				user: row.user,
				protocolVersion: row.protocolVersion,
				initialized: row.initialized,
			});
		}
		return { count: rows.length, rows };
	}
}

export class QaControl extends Resource {
	static loadAsInstance = false;

	async get(query) {
		const action = query.get('action');
		if (!action) throw new Error('missing required query param: action');
		if (action === 'worker') {
			return { pid: process.pid, threadId };
		}
		if (action === 'events') {
			const kind = query.get('kind');
			if (!kind) throw new Error('missing required query param: kind');
			const events = [];
			for await (const row of tables.QaEvent.search({
				conditions: [{ attribute: 'kind', value: kind }],
			})) {
				events.push({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload) });
			}
			return { count: events.length, events };
		}
		throw new Error(`unknown action: ${action}`);
	}

	async post(_target, body) {
		if (!body || typeof body.action !== 'string') {
			throw new Error('missing required body.action');
		}
		if (body.action === 'set_instructions') {
			server.setMcpInstructions(body.value === null ? undefined : body.value);
			return { ok: true, threadId };
		}
		if (body.action === 'set_card') {
			server.setMcpServerCard(body.value === null ? undefined : body.value);
			return { ok: true, threadId };
		}
		if (body.action === 'try_invalid_card') {
			try {
				server.setMcpServerCard(body.value);
				return { threw: false };
			} catch (err) {
				return { threw: true, name: err?.name ?? null, message: err?.message ?? String(err) };
			}
		}
		if (body.action === 'clear_events') {
			const ids = [];
			for await (const row of tables.QaEvent.search({})) {
				ids.push(row.id);
			}
			for (const id of ids) {
				await tables.QaEvent.delete(id);
			}
			return { ok: true, deleted: ids.length };
		}
		throw new Error(`unknown action: ${body.action}`);
	}
}

export class QaApp extends Resource {
	static mcpTools = [
		{
			name: 'qa_echo',
			description: 'Echo message along with MCP call context metadata',
			method: 'doEcho',
			inputSchema: {
				type: 'object',
				properties: { msg: { type: 'string' } },
			},
		},
		{
			name: 'qa_stream',
			description: 'Stream progress updates and respond to AbortSignal',
			method: 'doStream',
			inputSchema: {
				type: 'object',
				properties: {
					steps: { type: 'number' },
					delayMs: { type: 'number' },
					tag: { type: 'string' },
				},
			},
		},
	];

	static mcpPrompts = [
		{
			name: 'qa_prompt',
			description: 'Render prompt exposing stateless PromptRenderContext',
			arguments: [{ name: 'topic', description: 'Prompt topic', required: true }],
			render: (args, context) => ({
				description: 'QA stateless prompt render',
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: JSON.stringify({
								topic: args?.topic ?? null,
								contextReceived: context !== undefined,
								profile: context?.profile ?? null,
								username: context?.user?.username ?? null,
								sessionIdIsUndefined: context?.sessionId === undefined,
								sessionIdValue: context?.sessionId === undefined ? '__UNDEFINED__' : context.sessionId,
							}),
						},
					},
				],
			}),
		},
	];

	async doEcho(args, context) {
		return {
			pid: process.pid,
			threadId,
			username: context?.user?.username ?? null,
			profile: context?.profile ?? null,
			sessionIdIsUndefined: context?.sessionId === undefined,
			sessionIdValue: context?.sessionId === undefined ? '__UNDEFINED__' : context.sessionId,
			hasServerRequest: context?.serverRequest !== undefined,
			echo: args?.msg ?? '',
		};
	}

	async doStream(args, context) {
		const steps = typeof args?.steps === 'number' ? args.steps : 3;
		const delayMs = typeof args?.delayMs === 'number' ? args.delayMs : 30;
		const tag = typeof args?.tag === 'string' ? args.tag : 'default';
		let completedSteps = 0;
		try {
			for (let i = 1; i <= steps; i++) {
				context?.progress?.({ progress: i, total: steps, message: `${tag}:step-${i}` });
				await abortableDelay(delayMs, context?.signal);
				completedSteps = i;
			}
		} catch (err) {
			await recordEvent('stream_aborted', {
				tag,
				completedSteps,
				aborted: context?.signal?.aborted === true,
				reason: err instanceof Error ? err.message : String(err),
				sessionIdIsUndefined: context?.sessionId === undefined,
				hasServerRequest: context?.serverRequest !== undefined,
			});
			throw err;
		}
		return {
			tag,
			completedSteps,
			aborted: context?.signal?.aborted === true,
			sessionIdIsUndefined: context?.sessionId === undefined,
			hasServerRequest: context?.serverRequest !== undefined,
			threadId,
		};
	}
}
