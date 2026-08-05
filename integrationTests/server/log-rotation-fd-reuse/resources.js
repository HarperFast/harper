// QA-686 — deterministic log-volume generator for the main hdb.log.
//
// Each POST writes LINES_PER_REQUEST log lines of known minimum size directly via the
// component-scope `logger`, so the test can compute a guaranteed LOWER BOUND on bytes written
// (requests * LINES_PER_REQUEST * PADDING.length) independent of whatever timestamp/level/thread
// prefix the logger framework adds on top (which only makes each line BIGGER, never smaller).

let counter = 0;
const PADDING = 'X'.repeat(500);
const LINES_PER_REQUEST = 6;

export class Bump extends Resource {
	static loadAsInstance = false;

	async post(_query, _body) {
		const id = `p${counter++}`;
		for (let i = 0; i < LINES_PER_REQUEST; i++) {
			logger.error(`qa686 volume line ${i} req=${id} ${PADDING}`);
		}
		return { ok: true, n: counter };
	}
}
