// bin/harper.ts's import shape under ESM: the sizing module first, then an import that touches the
// filesystem while the graph is still evaluating. Reports the pool libuv actually built.
import '#src/bin/uvThreadPool';
import './uvThreadPoolEsmProbe.mjs';

import { readdirSync, readFileSync } from 'node:fs';

let workers = 0;
for (const task of readdirSync('/proc/self/task')) {
	try {
		if (readFileSync(`/proc/self/task/${task}/comm`, 'utf8').startsWith('libuv')) workers++;
	} catch {
		// a thread can exit between readdir and read
	}
}
process.stdout.write(JSON.stringify({ size: process.env.UV_THREADPOOL_SIZE, workers }));
