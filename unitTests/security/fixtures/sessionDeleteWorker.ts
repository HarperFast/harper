import { workerData } from 'node:worker_threads';
import { open } from 'lmdb';

const gate = new Int32Array(workerData.gate);
const root = open({ path: workerData.path, maxDbs: 10000 });
const sessions = root.openDB({ name: workerData.name, useVersions: true, encoding: 'binary' });
Atomics.store(gate, 0, 1);
Atomics.notify(gate, 0);
if (Atomics.wait(gate, 0, 1, 10000) === 'timed-out') throw new Error('session delete was never requested');
if (!sessions.removeSync(workerData.id)) throw new Error('session delete did not find its record');
Atomics.store(gate, 0, 3);
Atomics.notify(gate, 0);
await root.close();
