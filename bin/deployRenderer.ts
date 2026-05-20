import { Transform } from 'node:stream';
// cli-progress is already a runtime dep of harper (see package.json); using its
// SingleBar to render the upload phase here doesn't add a new dependency.
import cliProgress from 'cli-progress';
import type { SSEMessage } from './sseConsumer.ts';

interface RendererOptions {
	uploadTotal?: number;
	output?: NodeJS.WritableStream;
}

interface UploadState {
	bar: cliProgress.SingleBar | null;
	sent: number;
	textLastLogged: number;
	finished: boolean;
}

interface PhaseState {
	current?: string;
	installManager?: string;
	installLineCount: number;
}

/**
 * Deploy-time renderer that owns the progress display across two phases:
 *
 *   1. Local upload — driven by `tapUploadStream`, which wraps the multipart body so we
 *      can update a `cli-progress` bar against the precomputed uncompressed source-tree
 *      total. In a non-TTY environment (CI logs, redirected output) we fall back to
 *      periodic text lines so logs stay grep-able.
 *
 *   2. Server-side phases — driven by `renderEvent`, called for each SSE message the
 *      CLI receives from the operations API. Phase events print one-liners; live
 *      `install` events (npm/pnpm/yarn stdout) are throttled to one line under a
 *      "[install]" header so a noisy `npm install` doesn't drown the terminal.
 *
 * Designed so the two phases hand off cleanly: `endUpload()` tears the bar down (so
 * it doesn't compete with subsequent prints) before any SSE events render.
 */
export class DeployRenderer {
	private upload: UploadState = { bar: null, sent: 0, textLastLogged: 0, finished: false };
	private phase: PhaseState = { installLineCount: 0 };
	private output: NodeJS.WritableStream;
	private isTty: boolean;
	private uploadTotal: number;

	constructor(options: RendererOptions = {}) {
		this.output = options.output ?? process.stderr;
		// Only render a bar when stderr is a real terminal. CI runners, log redirection,
		// and pipes look identical from Node's perspective: !isTTY.
		this.isTty = Boolean((this.output as NodeJS.WriteStream).isTTY);
		this.uploadTotal = options.uploadTotal ?? 0;
	}

	/**
	 * Wrap an outbound stream so each byte flowing through it advances the upload bar.
	 * The Transform is identity — chunks pass through unmodified.
	 */
	tapUploadStream<T extends NodeJS.ReadableStream>(stream: T): NodeJS.ReadableStream {
		this.upload.bar = this.isTty
			? new cliProgress.SingleBar(
					{
						format: 'Uploading [{bar}] {percentage}% | {value}/{total} bytes',
						barCompleteChar: '█',
						barIncompleteChar: '░',
						hideCursor: true,
						stream: this.output,
						etaBuffer: 50,
					},
					cliProgress.Presets.shades_classic
				)
			: null;
		this.upload.bar?.start(this.uploadTotal || 1, 0);

		const counter = new Transform({
			transform: (chunk, _enc, cb) => {
				this.upload.sent += chunk.length;
				this.tickUpload();
				cb(null, chunk);
			},
			flush: (cb) => {
				this.endUpload();
				cb();
			},
		});
		stream.on('error', (err) => counter.destroy(err));
		stream.pipe(counter);
		return counter;
	}

	endUpload(): void {
		if (this.upload.finished) return;
		this.upload.finished = true;
		if (this.upload.bar) {
			// Snap to total so the bar shows 100% even when our uncompressed-total estimate
			// is slightly off (gzip output is usually smaller than the source tree).
			if (this.uploadTotal > 0) this.upload.bar.update(this.uploadTotal);
			this.upload.bar.stop();
			this.upload.bar = null;
		} else {
			this.output.write(`Upload complete (${formatBytes(this.upload.sent)})\n`);
		}
	}

	private tickUpload(): void {
		if (this.upload.bar) {
			this.upload.bar.update(this.upload.sent);
			return;
		}
		// Non-TTY: log a line every 10% of the total (or every 5MB if total unknown).
		const step = this.uploadTotal > 0 ? this.uploadTotal / 10 : 5 * 1024 * 1024;
		if (this.upload.sent - this.upload.textLastLogged >= step) {
			this.upload.textLastLogged = this.upload.sent;
			const pct = this.uploadTotal > 0 ? Math.min(100, Math.floor((this.upload.sent / this.uploadTotal) * 100)) : null;
			this.output.write(
				pct !== null
					? `Uploaded ${formatBytes(this.upload.sent)} / ~${formatBytes(this.uploadTotal)} (${pct}%)\n`
					: `Uploaded ${formatBytes(this.upload.sent)}\n`
			);
		}
	}

	renderEvent(message: SSEMessage): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message.data);
		} catch {
			parsed = message.data;
		}
		switch (message.event) {
			case 'phase':
				this.renderPhase(parsed as { phase?: string; status?: string; message?: string });
				break;
			case 'install':
				this.renderInstall(parsed as { manager?: string; stream?: string; line?: string });
				break;
			case 'error': {
				const e = parsed as { message?: string; code?: string | number };
				this.output.write(`error: ${e.message ?? message.data}${e.code ? ` (${e.code})` : ''}\n`);
				break;
			}
			case 'done':
				// Caller picks up final result via the SSE iterator; nothing to render here.
				break;
		}
	}

	private renderPhase(data: { phase?: string; status?: string; message?: string }): void {
		const label = data.phase ?? '?';
		if (data.status === 'start') {
			if (this.phase.current !== label) {
				this.output.write(`${label}…\n`);
				this.phase.current = label;
				this.phase.installLineCount = 0;
			}
		} else if (data.status === 'done') {
			if (label === 'install' && this.phase.installLineCount > 0) {
				this.output.write(`install done (${this.phase.installLineCount} log lines)\n`);
			} else {
				this.output.write(`${label} done\n`);
			}
		} else if (data.status === 'error') {
			this.output.write(`${label} ERROR: ${data.message ?? 'failed'}\n`);
		}
	}

	private renderInstall(data: { manager?: string; stream?: string; line?: string }): void {
		const line = (data.line ?? '').trimEnd();
		if (!line) return;
		if (data.manager && data.manager !== this.phase.installManager) {
			this.phase.installManager = data.manager;
			this.output.write(`install: using ${data.manager}\n`);
		}
		this.phase.installLineCount++;
		// Prefix with stream so users can distinguish stderr noise from stdout warnings.
		const tag = data.stream === 'stderr' ? '!' : '|';
		this.output.write(`  ${tag} ${line}\n`);
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
