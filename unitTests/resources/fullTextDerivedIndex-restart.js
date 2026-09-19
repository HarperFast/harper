// Child-process fixture for the restart test in fullTextDerivedIndex.test.js. Mocha also discovers
// this file, so keep all work behind the entry-point guard.
if (require.main === module) {
	const fs = require('node:fs');
	const path = require('node:path');
	const {
		FullTextDerivedIndexBackend,
		decodeFullTextCursorPayload,
	} = require('#src/resources/indexes/fullTextDerivedIndex');

	const [directory, phase] = process.argv.slice(2);
	const statePath = path.join(directory, 'native-state.json');
	fs.mkdirSync(directory, { recursive: true });

	const readState = () => {
		try {
			return JSON.parse(fs.readFileSync(statePath, 'utf8'));
		} catch (error) {
			if (error.code === 'ENOENT') return { committedPayload: undefined, documents: {} };
			throw error;
		}
	};
	const writeState = (state) => {
		const temporary = `${statePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(state));
		fs.renameSync(temporary, statePath);
	};
	const lifecycle = {
		inspect() {
			const state = readState();
			return state.committedPayload
				? { state: 'checkpointed', committedPayload: state.committedPayload }
				: { state: 'missing' };
		},
		async open() {
			const state = readState();
			return {
				committedPayload: state.committedPayload,
				async applyMutationBatch(batch) {
					for (const document of batch.upserts) state.documents[document.id] = document;
					for (const id of batch.deletes) delete state.documents[id];
					return {
						processed: batch.upserts.length + batch.deletes.length,
						rejected: [],
						encodedBytes: 1,
						frames: 1,
					};
				},
				async publish(payload) {
					state.committedPayload = payload;
					writeState(state);
					return 1n;
				},
				async close() {
					return {};
				},
			};
		},
		async reset() {
			writeState({ committedPayload: undefined, documents: {} });
		},
	};
	let epoch = 1n;
	const backend = new FullTextDerivedIndexBackend({
		id: 'restart-products',
		lifecycle,
		openAttempts: 1,
		openRetryMilliseconds: 0,
	});
	backend.attach({
		isOwnerEpoch: (candidate) => candidate === epoch,
		getReadiness: () => ({ state: 'ready', ownerEpoch: epoch, rebuildAttempts: 0 }),
	});
	const timestamp = phase === 'seed' ? 10 : 20;
	const id = phase === 'seed' ? 'a' : 'b';
	const batch = {
		ownerEpoch: epoch,
		transactions: [],
		records: [
			{
				tableId: 1,
				recordId: id,
				logVersion: timestamp,
				state: { kind: 'record', version: timestamp, projection: { title: id } },
			},
		],
		through: { format: 1, logs: { local: timestamp } },
		bytes: 32,
	};

	const run = async () => {
		if (phase === 'resume') {
			const durable = backend.getDurableCursor();
			if (durable?.logs.local !== 10) throw new Error('restart did not reuse the published cursor');
		}
		backend.deliver(batch);
		backend.flush();
		while (decodeFullTextCursorPayload(readState().committedPayload)?.logs.local !== timestamp)
			await new Promise((resolve) => setImmediate(resolve));
		if (phase === 'seed') process.kill(process.pid, 'SIGKILL');
		await backend.shutdown(epoch);
	};
	run().then(
		() => process.exit(0),
		(error) => {
			console.error(error);
			process.exit(1);
		}
	);
}
