// Submits threadpool work from its own module body, while the graph is still evaluating.
import { readFile } from 'node:fs/promises';

await readFile(import.meta.filename, 'utf8');
