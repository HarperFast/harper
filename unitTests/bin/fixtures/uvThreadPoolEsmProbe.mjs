// Submits threadpool work from its own module body — the import that would have won the race when
// the sizing assignment lived inline in bin/harper.ts.
import { readFile } from 'node:fs/promises';

await readFile(import.meta.filename, 'utf8');
