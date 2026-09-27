'use strict';

const { mkdirSync, rmSync } = require('node:fs');

class FullTextNativeTestBinding {
	constructor() {
		this.states = new Map();
		this.opens = [];
		this.resets = [];
		this.reclaims = [];
		this.reclaimWait = undefined;
		this.readerOpens = [];
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
			queryClassIsolationMinimumSearchThreads: 2,
			lifecycleApiVersion: 1,
			mutationBatchApiVersion: 4,
			queryApiVersion: 2,
			storageBackends: ['native'],
			limits: { maxCommitPayloadBytes: 64 * 1024, maxSearchWindow: 10_000, maxTraceRecords: 128 },
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

	async openNativeFullTextReader(options) {
		this.readerOpens.push(options);
		const binding = this;
		let state = this.states.get(key(options));
		if (!state) throw Object.assign(new Error('test index is not ready'), { code: 'E_INDEX_NOT_READY' });
		return {
			committedPayload: state.payload,
			async reload() {
				state = binding.states.get(key(options));
				if (!state) throw Object.assign(new Error('test index is not ready'), { code: 'E_INDEX_NOT_READY' });
				this.committedPayload = state.payload;
			},
			async search(request) {
				const query = request.query ?? { text: request.text, mode: request.mode, fields: request.fields };
				const candidates = request.candidateIds && new Set(request.candidateIds);
				const hits = [];
				for (const document of state.documents.values()) {
					if (candidates && !candidates.has(document.id)) continue;
					const score = scoreExpression(query, document.fields);
					if (score > 0) hits.push({ id: document.id, version: document.version, score });
				}
				hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
				const offset = request.offset ?? 0;
				const limit = request.limit ?? 20;
				return {
					total: hits.length,
					totalRelation: 'exact',
					hits: hits.slice(offset, offset + limit),
				};
			},
			async traceMatches(request, records) {
				const terms = String(request.text).toLowerCase().split(/\s+/).filter(Boolean);
				return {
					complete: true,
					records: records.map((record) => ({
						id: record.id,
						values: (request.fields ?? Object.keys(record.fields)).flatMap((field) => {
							const source = Array.isArray(record.fields[field]) ? record.fields[field] : [record.fields[field]];
							return source.flatMap((value, valueIndex) => {
								if (typeof value !== 'string') return [];
								const lower = value.toLowerCase();
								const spans = terms.flatMap((term) => {
									const start = lower.indexOf(term);
									return start < 0 ? [] : [{ start, end: start + term.length }];
								});
								return spans.length === 0 ? [] : [{ field, valueIndex, spans }];
							});
						}),
					})),
				};
			},
			async close() {
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

function scoreExpression(expression, fields) {
	if (expression.operator === 'and') {
		const scores = expression.clauses.map((clause) => scoreExpression(clause, fields));
		return scores.every(Boolean) ? scores.reduce((total, score) => total + score, 0) : 0;
	}
	if (expression.operator === 'or')
		return expression.clauses.reduce((total, clause) => total + scoreExpression(clause, fields), 0);
	if (expression.operator === 'not') return scoreExpression(expression.clause, fields) ? 0 : 1;
	const selected = expression.fields ?? Object.keys(fields);
	const haystack = selected
		.flatMap((name) => (Array.isArray(fields[name]) ? fields[name] : [fields[name]]))
		.filter((value) => typeof value === 'string')
		.join(' ')
		.toLowerCase();
	const terms = String(expression.text ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (expression.mode === 'phrase') return haystack.includes(terms.join(' ')) ? terms.length : 0;
	const matches = terms.filter((term) => haystack.includes(term)).length;
	return expression.mode === 'all' ? (matches === terms.length ? matches : 0) : matches;
}

module.exports = { FullTextNativeTestBinding };
