'use strict';

// Preloaded into Harper's main thread through NODE_OPTIONS: records whether the compile cache was already on when
// the main thread compiled dist/bin/run.js, whose import graph is most of what that thread compiles.
const Module = require('node:module');
const { writeFileSync } = require('node:fs');
const { isMainThread } = require('node:worker_threads');

const output = process.env.COMPILE_CACHE_PROBE_OUT;
if (isMainThread && output) {
	const compile = Module.prototype._compile;
	Module.prototype._compile = function (content, filename) {
		if (/[\\/]dist[\\/]bin[\\/]run\.js$/.test(filename)) {
			writeFileSync(output, JSON.stringify({ cacheDirectory: Module.getCompileCacheDir?.() ?? null }));
			Module.prototype._compile = compile;
		}
		return compile.call(this, content, filename);
	};
}
