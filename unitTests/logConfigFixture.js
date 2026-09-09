'use strict';

/**
 * Pins the logger's config for a test file that asserts on what lands in a log FILE.
 *
 * harper_logger resolves its config once, at module load, from the machine it is running on:
 * getPropsFilePath() -> ~/.harperdb/hdb_boot_properties.file -> settings_path -> the config's
 * `logging` section. The module-level `log_to_file` that comes out of that gates every file write
 * in createLogger() — with no boot properties present, initLogSettings() takes its ENOENT path,
 * `log_to_file` is false, and `createLogger({ path })` silently writes nothing to that path.
 *
 * So these suites passed on a developer machine with Harper installed and failed on a clean one
 * (a CI runner, a fresh checkout) with ENOENT on the log they just wrote. initLogSettings()
 * tolerates a missing boot properties file when ROOTPATH names a directory holding a config, so
 * point it at one this fixture writes and force a re-init. Now the config under test is the one
 * in the fixture rather than whatever the machine happens to have.
 */

const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const hdbTerms = require('#src/utility/hdbTerms');
const harperLoggerModule = require('#src/utility/logging/harper_logger');

/**
 * @param level the logging.level to pin
 * @param logRoot absolute directory for the MAIN log. Defaults to a throwaway temp dir, and that
 *   is normally what you want: point it at a directory the test itself writes into and the test's
 *   own logger collides with the main one, because getFileLogger() keys its file loggers by path.
 * @returns a restore function; call it from `after`
 */
function pinLogConfig({ level = 'trace', stdStreams = false, logRoot } = {}) {
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-log-fixture-'));
	if (!logRoot) logRoot = path.join(rootPath, 'log');
	fs.mkdirpSync(logRoot);
	fs.writeFileSync(
		path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE),
		[
			`rootPath: ${JSON.stringify(rootPath)}`,
			'logging:',
			'  file: true',
			`  stdStreams: ${stdStreams}`,
			`  level: ${level}`,
			`  root: ${JSON.stringify(logRoot)}`,
			'',
		].join('\n')
	);

	const originalRootPath = process.env.ROOTPATH;
	// initLogSettings() ends in stdioLogging(), which replaces the real process.stdout/stderr
	// .write and adds an 'error' listener to both. Put them back on restore.
	const originalStdio = [process.stdout, process.stderr].map((stream) => ({
		stream,
		write: stream.write,
		handler: stream.harperStdioErrorHandler,
	}));

	process.env.ROOTPATH = rootPath;
	harperLoggerModule.initLogSettings(true);
	refreshExternalLogger();

	return function restoreLogConfig() {
		if (originalRootPath === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = originalRootPath;
		harperLoggerModule.initLogSettings(true);
		// Not the object that was there before: that one belonged to the mainLogger this re-init
		// just replaced. Pointing at the live logger is the invariant that matters.
		refreshExternalLogger();
		for (const { stream, write, handler } of originalStdio) {
			stream.write = write;
			if (stream.harperStdioErrorHandler) {
				stream.removeListener('error', stream.harperStdioErrorHandler);
				delete stream.harperStdioErrorHandler;
			}
			if (handler) {
				stream.harperStdioErrorHandler = handler;
				stream.on('error', handler);
			}
		}
		// requireUncached() leaves rewired module instances holding their own fd on this tree, closed
		// only by their own 10s CLOSE_LOG_FD_TIMEOUT, and Windows refuses to remove a tree while a
		// handle is open under it. Throwing here would fail the `after` hook of a suite that passed.
		try {
			fs.removeSync(rootPath);
		} catch {}
	};
}

/**
 * harper_logger ends with `module.exports = { ... externalLogger: exports.externalLogger ... }`, a
 * one-time snapshot taken just after the module-load initLogSettings() call. A re-init reassigns
 * the module's own externalLogger but cannot reach that snapshot, so `require(...).externalLogger`
 * would keep pointing at a logger belonging to the previous mainLogger — writing nowhere the
 * caller can see. Re-point it. (The double export layering is the underlying wart; this keeps the
 * fixture from silently changing what the global logger means.)
 */
function refreshExternalLogger() {
	harperLoggerModule.externalLogger = harperLoggerModule.forComponent('external');
}

module.exports = { pinLogConfig };
