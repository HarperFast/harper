import { supportedCompression } from '@harperfast/rocksdb-js';
import { setSupportedRocksCompression } from './rocksCompressionConfig.ts';

setSupportedRocksCompression(supportedCompression);
