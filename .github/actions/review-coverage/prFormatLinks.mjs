import { createHash } from 'node:crypto';

const ANCHOR_PATTERN =
	/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/(?:changes|files)[^\s)\]#]*#diff-([0-9a-f]{64})(?:([RL])(\d+))?/g;

export function fileAnchorHash(filePath) {
	return createHash('sha256').update(filePath, 'utf8').digest('hex');
}

export function stripFencedBlocks(body) {
	let fence = null;
	const prose = [];
	for (const line of String(body).replace(/\r\n?/g, '\n').split('\n')) {
		let offset = 0;
		let quoteDepth = 0;
		while (true) {
			const quote = line.slice(offset).match(/^[ \t]{0,3}>[ \t]?/)?.[0];
			if (!quote) break;
			offset += quote.length;
			quoteDepth++;
		}
		if (fence) {
			let content;
			if (!fence.quoteDepth && !fence.listIndent) content = line;
			else if (quoteDepth !== fence.quoteDepth) fence = null;
			else {
				content = line.slice(offset);
				if (fence.listIndent) {
					if (content.trim() && content.match(/^[ \t]*/)[0].length < fence.listIndent) fence = null;
					else content = content.slice(Math.min(fence.listIndent, content.length));
				}
			}
			if (fence) {
				const close = content.match(/^[ \t]*(`+|~+)[ \t]*$/);
				if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
				continue;
			}
		}
		let content = line.slice(offset);
		const list = content.match(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/)?.[0];
		if (list) {
			offset += list.length;
			content = line.slice(offset);
		}
		const open = content.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
		if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
			fence = { marker: open[1][0], length: open[1].length, quoteDepth, listIndent: list?.length || 0 };
			continue;
		}
		prose.push(line);
	}
	return prose.join('\n');
}

export function parseBodyAnchors(body) {
	return [...stripFencedBlocks(body).matchAll(ANCHOR_PATTERN)].map((match) => ({
		url: match[0],
		repo: match[1],
		number: Number(match[2]),
		hash: match[3],
		side: match[4] ?? null,
		line: match[5] ? Number(match[5]) : null,
	}));
}

function withinAnyRange(ranges, line) {
	return ranges.some(([start, end]) => line >= start && line <= end);
}

export function checkBodyLinks({ body, prFiles, repo, number }) {
	const anchors = parseBodyAnchors(body);
	const lineAnchored = anchors.filter((anchor) => anchor.line !== null);
	const files = new Map(
		(prFiles?.files ?? []).map((file) => [
			fileAnchorHash(file.path),
			{ path: file.path, ranges: file.ranges, patchAvailable: file.patchAvailable },
		])
	);
	const problems = [];
	let unverifiable = !prFiles;

	if (lineAnchored.length === 0)
		problems.push({ kind: 'no-line-anchor', message: 'description has no line-anchored PR-diff link' });
	for (const anchor of anchors) {
		const where = `#diff-${anchor.hash.slice(0, 12)}…${anchor.side ?? ''}${anchor.line ?? ''}`;
		if (anchor.repo.toLowerCase() !== repo.toLowerCase() || anchor.number !== number) {
			problems.push({
				kind: 'foreign-pr',
				message: `${where} points at ${anchor.repo}#${anchor.number}, not ${repo}#${number}`,
			});
			continue;
		}
		const file = files.get(anchor.hash);
		if (!file) {
			if (prFiles && !prFiles.complete) unverifiable = true;
			else problems.push({ kind: 'unknown-file', message: `${where} does not match a file in the current diff` });
			continue;
		}
		if (anchor.line === null) continue;
		if (!file.patchAvailable) {
			unverifiable = true;
			continue;
		}
		if (!withinAnyRange(file.ranges[anchor.side], anchor.line))
			problems.push({
				kind: 'line-not-in-diff',
				message: `${file.path}${anchor.side}${anchor.line} is not in a current diff hunk`,
			});
	}
	return { ok: problems.length === 0 && !unverifiable, problems, anchors, lineAnchored, unverifiable };
}
