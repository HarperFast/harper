'use strict';

const assert = require('node:assert');

(async () => {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const { mode, options, documents, payload, version = '0.5.0' } = JSON.parse(Buffer.concat(chunks));
	assert(['0.5.0', '0.7.0'].includes(version));
	const binding = await import(
		version === '0.7.0' ? '@harperfast/fulltext-v07/native' : '@harperfast/fulltext-previous/native'
	);
	const info = await binding.runtimeInfo();
	assert.strictEqual(info.packageVersion, version);
	assert.strictEqual(info.tantivyVersion, version === '0.7.0' ? '0.27.0' : '0.26.2');
	let index;
	let ghostIds;
	try {
		if (mode === 'seed') {
			index = await binding.openNativeFullTextIndex(options);
			await index.applyMutationBatch({ upserts: documents, deletes: [] });
			await index.publish(payload);
			ghostIds = (await index.search({ text: 'migrationghost', exactTotal: true })).hits.map(({ id }) => id);
			await index.close({ mode: 'require-clean' });
			index = undefined;
		}
		let resetError;
		if (mode === 'reset') {
			try {
				await binding.resetNativeFullTextIndex({ path: options.path, indexId: options.indexId });
			} catch (error) {
				resetError = error.code;
			}
		}
		const inspection = binding.inspectNativeFullTextIndex(options);
		let openError;
		if (mode === 'inspect') {
			try {
				const reader = await binding.openNativeFullTextReader(options);
				await reader.close();
			} catch (error) {
				openError = error.code;
			}
		}
		console.log(JSON.stringify({ inspection, openError, resetError, ghostIds }));
	} finally {
		await index?.close({ mode: 'rollback' });
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
