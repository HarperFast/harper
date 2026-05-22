require('../testUtils');
const assert = require('assert');
const { pack } = require('msgpackr');
const { RecordEncoder } = require('#src/resources/RecordEncoder');

describe('RecordEncoder.decode', () => {
	describe('LMDB version prefix handling', () => {
		// lmdb-js prepends an 8-byte float64 version header to every value on stores opened
		// with `useVersions: true`. When `put(key, value)` is called without an explicit
		// version (as in lmdb-js's internal `saveStructures`), the version defaults to 0,
		// producing a buffer that begins with 8 zero bytes. The decoder must skip this
		// prefix instead of misreading it as Harper metadata flags.
		it('decodes a buffer with an 8-byte version=0 prefix (e.g. shared structures)', () => {
			const encoder = new RecordEncoder({ name: 'test' });
			const payload = [['field1', 'field2'], ['fieldA']];
			const msgpackData = pack(payload);
			const lmdbBuffer = Buffer.concat([Buffer.alloc(8), msgpackData]);

			const decoded = encoder.decode(lmdbBuffer);

			assert.deepEqual(decoded, payload);
		});

		it('still decodes a buffer with Harper timestamp prefix (first byte 0x02)', () => {
			const encoder = new RecordEncoder({ name: 'test' });
			const payload = ['hello', 'world'];
			const msgpackData = pack(payload);
			// First byte 0x02 matches the ordered-binary encoded float64 prefix Harper
			// produces for recent millisecond timestamps (0x42 XOR 0x40 = 0x02).
			const prefix = Buffer.from([0x02, 0x78, 0xd5, 0xa0, 0x00, 0x00, 0x00, 0x00]);
			const lmdbBuffer = Buffer.concat([prefix, msgpackData]);

			const decoded = encoder.decode(lmdbBuffer);

			assert.deepEqual(decoded, payload);
		});

		it('decodes a buffer with no metadata prefix (first byte >= 32) as plain msgpack', () => {
			const encoder = new RecordEncoder({ name: 'test' });
			const payload = ['plain', 'record'];
			const msgpackData = pack(payload);

			const decoded = encoder.decode(msgpackData);

			assert.deepEqual(decoded, payload);
		});

		it('does not mistake legacy 2-byte metadata (first byte 0, second byte non-zero) for a version prefix', () => {
			// Legacy 2-byte metadata records exist where the low 5 flag bits are 0 but
			// higher bits are set. Example: HAS_RESIDENCY_ID alone (= 32) encodes as
			// [0x00, 0x01, <4 bytes residency_id>, ...msgpack...]. The decoder must
			// NOT treat this as an lmdb-js version=0 prefix and skip 8 bytes.
			const encoder = new RecordEncoder({ name: 'test' });
			const payload = ['after', 'metadata'];
			const msgpackData = pack(payload);
			// 2-byte metadata = [0x00, 0x01] = HAS_RESIDENCY_ID; then 4 bytes residency_id.
			const legacyPrefix = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x07]);
			const buffer = Buffer.concat([legacyPrefix, msgpackData]);

			const decoded = encoder.decode(buffer);

			assert.deepEqual(decoded, payload);
		});
	});
});
