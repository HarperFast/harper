'use strict';
const assert = require('node:assert');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// RocksDB's backup meta records a crc32c per file, verified as the file is copied out.
function crc32c(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

// A table whose footer declares a format_version this build does not know — what a newer
// binding's table format looks like to this one — with its checksum re-recorded, so only a
// check that opens the table can refuse it.
function writeUnsupportedTableFormat(backupDir, backupId) {
	// a table file this backup records, not merely one in the shared directory: an incremental
	// backup lists only the files its own generation holds
	const metaPath = join(backupDir, 'meta', String(backupId));
	const meta = readFileSync(metaPath, 'utf8');
	const listed = meta.match(/^shared_checksum\/(\S+\.sst) crc32 \d+$/m);
	assert.ok(listed, 'precondition: the backup holds a table file');
	const sst = listed[1];
	assert.ok(readdirSync(join(backupDir, 'shared_checksum')).includes(sst), `precondition: ${sst} is in the repository`);
	const sstPath = join(backupDir, 'shared_checksum', sst);
	const contents = readFileSync(sstPath);
	contents.writeUInt32LE(99, contents.length - 12);
	writeFileSync(sstPath, contents);
	const entry = new RegExp(`^(shared_checksum/${sst} crc32 )\\d+$`, 'm');
	writeFileSync(metaPath, meta.replace(entry, `$1${crc32c(contents)}`));
	return sst;
}

module.exports = { crc32c, writeUnsupportedTableFormat };
