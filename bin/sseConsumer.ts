import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

export interface SSEMessage {
	event: string;
	data: string;
	id?: string;
	retry?: number;
}

/**
 * Parse a Readable carrying Server-Sent Events into structured messages.
 *
 * Yields one `SSEMessage` per blank-line-terminated record. Handles split data: lines,
 * CRLF or LF line endings, and arbitrary chunk boundaries — the underlying Node http
 * Readable does not guarantee chunks align with SSE record boundaries.
 */
export async function* parseSSE(stream: Readable): AsyncGenerator<SSEMessage> {
	const decoder = new StringDecoder('utf8');
	let buffer = '';
	for await (const chunk of stream) {
		buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
		while (true) {
			const recordEnd = buffer.indexOf('\n\n');
			const crlfEnd = buffer.indexOf('\r\n\r\n');
			let endIdx = -1;
			let delimLen = 0;
			if (recordEnd !== -1 && (crlfEnd === -1 || recordEnd < crlfEnd)) {
				endIdx = recordEnd;
				delimLen = 2;
			} else if (crlfEnd !== -1) {
				endIdx = crlfEnd;
				delimLen = 4;
			}
			if (endIdx === -1) break;
			const record = buffer.slice(0, endIdx);
			buffer = buffer.slice(endIdx + delimLen);
			const msg = parseRecord(record);
			if (msg) yield msg;
		}
	}
	buffer += decoder.end();
	// Any trailing record without a terminating blank line is treated as a final message,
	// matching the looser behavior browsers exhibit on connection close.
	if (buffer.trim()) {
		const msg = parseRecord(buffer);
		if (msg) yield msg;
	}
}

function parseRecord(record: string): SSEMessage | null {
	const lines = record.split(/\r?\n/);
	let event = 'message';
	let id: string | undefined;
	let retry: number | undefined;
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line === '' || line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		// Per spec, a leading space after the colon is stripped.
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		switch (field) {
			case 'event':
				event = value;
				break;
			case 'data':
				dataLines.push(value);
				break;
			case 'id':
				id = value;
				break;
			case 'retry': {
				const n = Number(value);
				if (Number.isFinite(n)) retry = n;
				break;
			}
		}
	}
	if (dataLines.length === 0 && event === 'message') return null;
	return { event, data: dataLines.join('\n'), id, retry };
}

interface RenderState {
	currentPhase?: string;
}

/**
 * Render SSE deploy events as terse, line-oriented progress to stderr (so stdout stays
 * reserved for the final JSON/YAML response document). Phase transitions print once.
 */
export function renderDeployProgress(message: SSEMessage, state: RenderState, output: NodeJS.WritableStream): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message.data);
	} catch {
		parsed = message.data;
	}
	switch (message.event) {
		case 'phase': {
			const p = parsed as { phase?: string; status?: string; rolling?: boolean };
			const label = p.phase ?? '?';
			if (p.status === 'start') {
				if (state.currentPhase !== label) {
					output.write(`${label}…\n`);
					state.currentPhase = label;
				}
			} else if (p.status === 'done') {
				output.write(`${label} done\n`);
			} else if (p.status === 'error') {
				const msg = (parsed as { message?: string }).message ?? 'failed';
				output.write(`${label} ERROR: ${msg}\n`);
			}
			break;
		}
		case 'error': {
			const e = parsed as { message?: string; code?: string | number };
			output.write(`error: ${e.message ?? message.data}${e.code ? ` (${e.code})` : ''}\n`);
			break;
		}
		case 'done':
			// Caller picks up the final result via the SSE iterator; nothing to render here.
			break;
	}
}
