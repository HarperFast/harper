'use strict';

// Loads the sizing module the way bin/harper.ts does, then forces libuv to build its pool and
// reports what it actually got. Driven by unitTests/bin/uvThreadPool.test.js.
require('#src/bin/uvThreadPool');

const { readdirSync, readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');

// The pool is created synchronously when the first task is submitted, so every worker thread
// exists by the time this read resolves.
readFile(__filename, 'utf8').then(() => {
	let workers = 0;
	if (process.platform === 'linux') {
		for (const task of readdirSync('/proc/self/task')) {
			try {
				if (readFileSync(`/proc/self/task/${task}/comm`, 'utf8').startsWith('libuv')) workers++;
			} catch {
				// a thread can exit between readdir and read
			}
		}
	}
	process.stdout.write(JSON.stringify({ size: process.env.UV_THREADPOOL_SIZE, workers }));
});
