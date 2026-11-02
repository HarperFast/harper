import http from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';

interface JsonRequestOptions {
	method?: string;
	headers?: OutgoingHttpHeaders;
	body?: unknown;
	signal?: AbortSignal;
}

/** Keep interrupted HTTP messages distinct from complete responses containing invalid JSON. */
export function requestJson(url: string, options: JsonRequestOptions = {}) {
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
		: AbortSignal.timeout(30_000);
	return new Promise<{
		status: number;
		coverage: string | null;
		aborted: boolean;
		text: string;
		body: any;
	}>((resolve, reject) => {
		let responded = false;
		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(signal.aborted ? signal.reason : error);
		};
		const request = http.request(
			url,
			{ method: options.method, headers: options.headers, agent: false, signal },
			(response) => {
				responded = true;
				const chunks: Buffer[] = [];
				response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
				response.on('error', (error) => {
					if (signal.aborted || response.complete) fail(error);
				});
				response.on('close', () => {
					if (settled) return;
					if (signal.aborted) return fail(signal.reason);
					const text = Buffer.concat(chunks).toString('utf8');
					try {
						const body = text && response.complete ? JSON.parse(text) : undefined;
						settled = true;
						resolve({
							status: response.statusCode!,
							coverage: (response.headers['harper-index-coverage'] as string | undefined) ?? null,
							aborted: !response.complete,
							text,
							body,
						});
					} catch (error) {
						fail(error);
					}
				});
			}
		);
		request.on('error', (error) => {
			if (signal.aborted || !responded) fail(error);
		});
		request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
	});
}
