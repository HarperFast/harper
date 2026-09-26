'use strict';

const { mkdirSync, rmSync } = require('node:fs');

class FullTextNativeTestBinding {
	constructor() {
		this.states = new Map();
		this.opens = [];
		this.resets = [];
		this.reclaims = [];
		this.reclaimWait = undefined;
		this.resetWait = undefined;
		this.closeAttempts = 0;
		this.closeError = undefined;
		this.resetError = undefined;
		this.resetFailuresRemaining = 0;
		this.closeBarrier = undefined;
		this.NativeFullTextIndex = class {
			applyMutationBatch() {}
			publish() {}
			close() {}
		};
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 5,
			lifecycleApiVersion: 1,
			mutationBatchApiVersion: 3,
			storageBackends: ['native'],
			limits: { maxCommitPayloadBytes: 64 * 1024 },
		};
	}

	validateNativeFullTextIndexOptions() {}

	inspectNativeFullTextIndex(options) {
		const state = this.states.get(key(options));
		return state?.payload ? { state: 'checkpointed', committedPayload: state.payload } : { state: 'missing' };
	}

	async openNativeFullTextIndex(options) {
		this.opens.push(options);
		mkdirSync(options.path, { recursive: true });
		const binding = this;
		let state = this.states.get(key(options));
		if (!state) this.states.set(key(options), (state = { documents: new Map(), payload: undefined }));
		return {
			committedPayload: state.payload,
			async applyMutationBatch(batch) {
				for (const id of batch.deletes) state.documents.delete(id);
				for (const document of batch.upserts) state.documents.set(document.id, document);
				return {
					processed: batch.upserts.length + batch.deletes.length,
					rejected: [],
					encodedBytes: 1,
					frames: 1,
				};
			},
			async publish(payload) {
				state.payload = payload;
				this.committedPayload = payload;
				return 1n;
			},
			async close() {
				binding.closeAttempts++;
				await binding.closeBarrier;
				if (binding.closeError) throw binding.closeError;
				return {};
			},
		};
	}

	async resetNativeFullTextIndex(options) {
		this.resets.push(options);
		await this.resetWait;
		if (this.resetFailuresRemaining > 0) {
			this.resetFailuresRemaining--;
			throw Object.assign(new Error('another writer owns the index'), { code: 'E_LOCK_BUSY' });
		}
		if (this.resetError) throw this.resetError;
		const prefix = `${options.path}\0${options.indexId}\0`;
		let removed = false;
		for (const stateKey of this.states.keys()) {
			if (!stateKey.startsWith(prefix)) continue;
			this.states.delete(stateKey);
			removed = true;
		}
		if (removed) rmSync(options.path, { recursive: true, force: true });
		return removed ? { state: 'reset', retiredPath: 'test-retired' } : { state: 'missing' };
	}

	async reclaimRetiredNativeFullTextIndexes(options) {
		this.reclaims.push(options);
		await this.reclaimWait;
		return { removed: 0, failed: 0 };
	}
}

function key(options) {
	return `${options.path}\0${options.indexId}\0${options.generation}`;
}

module.exports = { FullTextNativeTestBinding };
