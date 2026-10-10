'use strict';

/**
 * Builds a minimal ELF64 shared object: header, .dynstr, .dynsym, and three section headers (null,
 * .dynstr, .dynsym). Each symbol is `{ name, defined }`; an undefined symbol has st_shndx 0.
 */
function buildElf64(symbols, { littleEndian = true, sectionHeaders = true, elfClass = 2 } = {}) {
	const write16 = (buffer, at, value) =>
		littleEndian ? buffer.writeUInt16LE(value, at) : buffer.writeUInt16BE(value, at);
	const write32 = (buffer, at, value) =>
		littleEndian ? buffer.writeUInt32LE(value, at) : buffer.writeUInt32BE(value, at);
	const write64 = (buffer, at, value) =>
		littleEndian ? buffer.writeBigUInt64LE(BigInt(value), at) : buffer.writeBigUInt64BE(BigInt(value), at);

	const names = Buffer.from('\0' + symbols.map((symbol) => symbol.name + '\0').join(''));
	const symbolTable = Buffer.alloc(24 * (symbols.length + 1));
	let nameOffset = 1;
	symbols.forEach((symbol, index) => {
		const at = 24 * (index + 1);
		write32(symbolTable, at, nameOffset);
		symbolTable[at + 4] = 0x12; // STB_GLOBAL, STT_FUNC
		write16(symbolTable, at + 6, symbol.defined ? 1 : 0);
		nameOffset += Buffer.byteLength(symbol.name) + 1;
	});

	const namesAt = 64;
	const symbolsAt = namesAt + names.length;
	const sectionsAt = symbolsAt + symbolTable.length;
	const sections = Buffer.alloc(64 * 3);
	const writeSection = (index, type, offset, size, link, entrySize) => {
		const at = 64 * index;
		write32(sections, at + 4, type);
		write64(sections, at + 0x18, offset);
		write64(sections, at + 0x20, size);
		write32(sections, at + 0x28, link);
		write64(sections, at + 0x38, entrySize);
	};
	writeSection(1, 3, namesAt, names.length, 0, 0); // SHT_STRTAB
	writeSection(2, 11, symbolsAt, symbolTable.length, 1, 24); // SHT_DYNSYM

	const header = Buffer.alloc(64);
	header.writeUInt32BE(0x7f454c46, 0);
	header[4] = elfClass;
	header[5] = littleEndian ? 1 : 2;
	header[6] = 1;
	write16(header, 0x10, 3); // ET_DYN
	if (sectionHeaders) {
		write64(header, 0x28, sectionsAt);
		write16(header, 0x3a, 64);
		write16(header, 0x3c, 3);
		write16(header, 0x3e, 1);
	}
	return Buffer.concat([header, names, symbolTable, sections]);
}

const V8_API_SYMBOLS = [
	{ name: '_ZN2v87Isolate10GetCurrentEv' },
	{ name: '_ZNK2v85Value8IsObjectEv' },
	{ name: '_ZN2v86Object3NewEPNS_7IsolateE', defined: true },
	{ name: 'napi_create_object' },
	{ name: '_ZN4node6Buffer4NewEPN2v87IsolateEm' },
];
const NODE_API_SYMBOLS = [{ name: 'napi_create_object' }, { name: 'napi_module_register' }, { name: 'memcpy' }];

module.exports = { buildElf64, V8_API_SYMBOLS, NODE_API_SYMBOLS };
