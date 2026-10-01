'use strict';
/**
 * The sticky comment's hidden record of the SHA the workflow itself last
 * pushed to a cherry-pick branch — the durable state branch-guard.js compares
 * against so a reset/force-push/delete never clobbers a head it didn't push.
 */

const HEAD_MARKER_RE = /<!-- release-cherry-pick-head:([0-9a-f]{40})?\s*-->/;

/** Pull the recorded head SHA out of a sticky comment body, or null if absent. */
function extractRecordedHead(body) {
	const match = typeof body === 'string' && body.match(HEAD_MARKER_RE);
	return (match && match[1]) || null;
}

/** The hidden marker line to embed in a sticky comment body for a given head SHA. */
function headMarkerLine(sha) {
	return `<!-- release-cherry-pick-head:${sha || ''} -->`;
}

module.exports = { extractRecordedHead, headMarkerLine, HEAD_MARKER_RE };
