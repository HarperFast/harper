import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Buffer a streamed deploy_component payload to a temp tar.gz file on disk.
 *
 * Used by replicated deploys: the origin needs to keep a copy of the streamed payload so
 * it can re-stream it to each peer over the HTTPS relay (see harper-pro's deployRelay).
 * Without this, the payload Readable would be consumed once by local extraction and gone
 * by the time replication runs.
 *
 * Trade-off: we write the full payload to disk before extraction reads from it (instead of
 * tee-ing in-flight) so the local-deploy path stays unchanged — extractApplication still
 * gets a regular createReadStream over a complete file. Two passes over the data, but no
 * concurrent-tee complexity, and disk speed isn't the bottleneck on deploy.
 *
 * Returns the staged file's path and a cleanup function. The cleanup deletes the temp
 * directory; safe to call multiple times (rm with force).
 */
export async function stagePayloadToTempFile(
	source: Readable,
	projectName: string
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), `harper-deploy-${sanitize(projectName)}-`));
	const path = join(dir, 'payload.tar.gz');
	await pipeline(source, createWriteStream(path));
	const cleanup = async () => {
		await rm(dir, { recursive: true, force: true });
	};
	return { path, cleanup };
}

function sanitize(name: string): string {
	// keep alphanumerics, dashes, underscores; replace everything else so a malicious or
	// quirky project name (slashes, dots, control chars) can't escape the tmpdir.
	return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}
