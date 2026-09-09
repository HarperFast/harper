'use strict';

// A second isolate writing to the same log file as the main thread, which is how Harper actually
// produces request logs: every HTTP worker holds its own descriptor on one path.

const { isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread && workerData?.withoutTransport) {
	(async () => {
		const fs = require('fs-extra');
		const { requestStaleDescriptorRelease } = require('#src/utility/logging/logGenerationCoordinator');
		const {
			isArchivePendingQuiescence,
			publishArchivedGeneration,
			rotateLogFileSync,
		} = require('#src/utility/logging/logRotation');
		fs.mkdirpSync(workerData.rotatedDir);
		fs.writeFileSync(workerData.logPath, 'worker generation with no transport\n');
		const release = await requestStaleDescriptorRelease();
		const generation = rotateLogFileSync(workerData.logPath, workerData.rotatedDir, () => {});
		const published = await publishArchivedGeneration(generation, true);
		parentPort.postMessage({
			released: release.released,
			published,
			pending: isArchivePendingQuiescence(generation.archivePath),
			plainExists: fs.pathExistsSync(generation.archivePath),
			compressedExists: fs.pathExistsSync(`${generation.archivePath}.gz`),
		});
	})().catch((error) => parentPort.postMessage({ error: error.stack || error.message }));
} else if (!isMainThread && workerData?.logPath) {
	const hdbLogger = require('#src/utility/logging/harper_logger');
	const logger = hdbLogger.createLogger({
		stdStreams: false,
		path: workerData.logPath,
		level: 'error',
		rotation: workerData.rotation,
	});
	for (let i = 0; i < workerData.lineCount; i++) logger.error(`${workerData.markerPrefix}-${i}-${'q'.repeat(40)}`);
	// The sink buffers under load and flushes on a timer; reporting done before that timer fires
	// would let the main thread read the file while this thread's last entries are still in memory.
	setTimeout(() => {
		logger.closeLogFile();
		parentPort.postMessage({ done: true });
	}, 200);
}
