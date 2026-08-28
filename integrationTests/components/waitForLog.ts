import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForLogMatches(logFile: string, patterns: RegExp[], timeoutMs = 15_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let contents = '';
	while (Date.now() < deadline) {
		try {
			contents = await readFile(logFile, 'utf8');
			if (patterns.every((pattern) => pattern.test(contents))) return contents;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		await delay(200);
	}
	return contents;
}
