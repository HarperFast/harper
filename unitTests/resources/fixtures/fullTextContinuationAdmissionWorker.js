'use strict';
const { parentPort, threadId, workerData } = require('node:worker_threads');
workerData.noServerStart = true;
const { onMessageByType } = require('#js/server/threads/manageThreads');
const {
	reserveFullTextContinuation,
	releaseFullTextContinuation,
	fullTextContinuationDeadline,
} = require('#src/resources/indexes/fullTextContinuation');
const claims = [];
let writer, reader;
onMessageByType('full-text-admission-test-command', async (event) => {
	try {
		if (event.message.operation === 'native') {
			const { requestFullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuation');
			const value = await requestFullTextContinuationOwner(
				event.message.owner,
				event.message.command,
				fullTextContinuationDeadline()
			);
			parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, value } });
			return;
		} else if (event.message.operation === 'open') {
			const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
			const { fullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuationOwner');
			const { confirmFullTextContinuation } = require('#src/resources/indexes/fullTextContinuation');
			const binding = await loadFullTextNativeBinding();
			const info = await binding.runtimeInfo();
			const options = {
				path: event.message.path,
				indexId: 'worker-continuation',
				generation: '1',
				fields: [{ name: 'title' }],
				analyzer: 'english@2',
				limits: {
					indexingThreads: 1,
					searchThreads: Math.max(2, info.queryClassIsolationMinimumSearchThreads),
					writerMemoryBytes: 30000000,
					maxQueuedCommands: 16,
					maxQueuedBytes: 8388608,
					maxBatchBytes: 8388608,
				},
			};
			writer = await binding.openNativeFullTextIndex(options);
			await writer.applyMutationBatch({
				upserts: Array.from({ length: 40 }, (_, n) => ({ id: String(n), version: '1', fields: { title: 'widget' } })),
			});
			await writer.commit();
			reader = await binding.openNativeFullTextReader(options);
			const owner = await fullTextContinuationOwner();
			const claim = await reserveFullTextContinuation(128, fullTextContinuationDeadline());
			claims.push(claim);
			owner.leases.register(claim, 'b'.repeat(64), { text: 'widget' }, reader, () => {});
			await confirmFullTextContinuation(claim.id, fullTextContinuationDeadline());
			const token = owner.leases.seal(claim.id, 'b'.repeat(64), { batchSize: 7, consumed: 2 });
			parentPort.postMessage({
				type: 'full-text-admission-test-response',
				message: { originator: threadId, token, claim, responseBytes: owner.responseBytes(7) },
			});
			return;
		} else if (event.message.operation === 'update') {
			await writer.applyMutationBatch({
				upserts: [{ id: 'new', version: '2', fields: { title: 'widget widget widget' } }],
			});
			await writer.commit();
		} else if (event.message.operation === 'shutdown') {
			const { fullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuationOwner');
			await (await fullTextContinuationOwner()).leases.revokeReader(reader);
			await reader.close();
			await writer.close();
			for (const claim of claims.splice(0)) await releaseFullTextContinuation(claim.id);
		} else if (event.message.operation === 'reserve')
			claims.push(await reserveFullTextContinuation(128, fullTextContinuationDeadline()));
		else if (event.message.operation === 'release') await releaseFullTextContinuation(claims.pop().id);
		parentPort.postMessage({
			type: 'full-text-admission-test-response',
			message: { originator: threadId, count: claims.length },
		});
	} catch (error) {
		parentPort.postMessage({
			type: 'full-text-admission-test-response',
			message: { originator: threadId, error: error.message, status: error.statusCode },
		});
	}
});
parentPort.ref();
parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, ready: true } });
