import { fileURLToPath } from 'node:url';

export async function startOnMainThread() {
	const { startWorker } = await import(new URL('../../../../dist/server/threads/manageThreads.js', import.meta.url));
	startWorker(fileURLToPath(new URL('./faultWorker.cjs', import.meta.url)), {
		name: 'status-privacy',
		type: 'status-privacy',
		autoRestart: false,
	});
}
