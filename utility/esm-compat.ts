import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * Get __filename in a way that works in both ESM and CJS (when transpiled)
 */
export function getFilename(importMetaUrl: string): string {
    return fileURLToPath(importMetaUrl);
}

/**
 * Get __dirname in a way that works in both ESM and CJS (when transpiled)
 */
export function getDirname(importMetaUrl: string): string {
    return dirname(fileURLToPath(importMetaUrl));
}
