import { createHash } from 'node:crypto';

const ANCHOR_PATTERN =
	/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/(?:changes|files)(?:(?:\/[\w.-]+)?(?:\?[^\s)\]#]*)?)#diff-([0-9a-f]{64})(?:([RL])(\d+)(?:-([RL])(\d+))?)?(?![\w-])/g;

export function fileAnchorHash(filePath) {
	return createHash('sha256').update(filePath, 'utf8').digest('hex');
}

function stripInlineAndComments(line, commentOpen) {
	let prose = '';
	let index = 0;
	while (index < line.length) {
		if (commentOpen) {
			const close = line.indexOf('-->', index);
			if (close < 0) return { prose: prose + ' '.repeat(line.length - index), commentOpen };
			prose += ' '.repeat(close + 3 - index);
			index = close + 3;
			commentOpen = false;
			continue;
		}
		const comment = line.indexOf('<!--', index);
		const tick = line.indexOf('`', index);
		if (comment >= 0 && (tick < 0 || comment < tick)) {
			prose += line.slice(index, comment);
			index = comment;
			commentOpen = true;
			continue;
		}
		if (tick < 0) {
			prose += line.slice(index);
			break;
		}
		prose += line.slice(index, tick);
		let runEnd = tick;
		while (line[runEnd] === '`') runEnd++;
		const runLength = runEnd - tick;
		let close = runEnd;
		let matched = false;
		while (close < line.length) {
			close = line.indexOf('`', close);
			if (close < 0) break;
			let closeEnd = close;
			while (line[closeEnd] === '`') closeEnd++;
			if (closeEnd - close === runLength) {
				prose += ' '.repeat(closeEnd - tick);
				index = closeEnd;
				matched = true;
				break;
			}
			close = closeEnd;
		}
		if (!matched) {
			prose += line.slice(tick, runEnd);
			index = runEnd;
		}
	}
	return { prose, commentOpen };
}

function maskCode(line) {
	return line.replace(/\S/g, 'x');
}

export function inspectBodyText(body) {
	let fence = null;
	let commentOpen = false;
	let indentedCode = false;
	let previousBlank = true;
	let lastNonblankWasList = false;
	const prose = [];
	const visible = String(body).replace(/\r\n?/g, '\n');
	for (const line of visible.split('\n')) {
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
				const close = content.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/);
				if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
					fence = null;
					prose.push(' '.repeat(line.length));
				} else prose.push(maskCode(line));
				continue;
			}
		}
		if (commentOpen) {
			const stripped = stripInlineAndComments(line, commentOpen);
			commentOpen = stripped.commentOpen;
			prose.push(stripped.prose);
			previousBlank = stripped.prose.trim() === '';
			continue;
		}
		let content = line.slice(offset);
		const list = content.match(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/)?.[0];
		if (list) {
			offset += list.length;
			content = line.slice(offset);
		}
		const open = content.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
		if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
			fence = { marker: open[1][0], length: open[1].length, quoteDepth, listIndent: list?.length || 0 };
			prose.push(' '.repeat(line.length));
			continue;
		}
		const blank = content.trim() === '';
		if (blank) {
			prose.push('');
			previousBlank = true;
			continue;
		}
		const indented = /^(?: {4}|\t)/.test(line.slice(offset));
		if (indentedCode && indented) {
			prose.push(maskCode(line));
			continue;
		}
		if (indentedCode) indentedCode = false;
		if (indented && previousBlank && !lastNonblankWasList && !list) {
			indentedCode = true;
			prose.push(maskCode(line));
			continue;
		}
		const stripped = stripInlineAndComments(line, false);
		commentOpen = stripped.commentOpen;
		prose.push(stripped.prose);
		previousBlank = false;
		lastNonblankWasList = Boolean(list);
	}
	// Blanking keeps newlines and offsets stable for section-index comparisons in the evaluator.
	return { prose: prose.join('\n'), unterminatedComment: commentOpen, unterminatedFence: Boolean(fence) };
}

export function stripFencedBlocks(body) {
	return inspectBodyText(body).prose;
}

export function parseBodyAnchors(body) {
	return [...stripFencedBlocks(body).matchAll(ANCHOR_PATTERN)].map((match) => ({
		url: match[0],
		repo: match[1],
		number: Number(match[2]),
		hash: match[3],
		side: match[4] ?? null,
		line: match[5] ? Number(match[5]) : null,
		endSide: match[6] ?? null,
		endLine: match[7] ? Number(match[7]) : null,
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
	const identityAvailable = /^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isInteger(number) && number > 0;
	let unverifiable = !prFiles || !identityAvailable;

	if (lineAnchored.length === 0)
		problems.push({ kind: 'no-line-anchor', message: 'description has no line-anchored PR-diff link' });
	for (const anchor of anchors) {
		const where = `#diff-${anchor.hash.slice(0, 12)}…${anchor.side ?? ''}${anchor.line ?? ''}`;
		if (identityAvailable && (anchor.repo.toLowerCase() !== repo.toLowerCase() || anchor.number !== number)) {
			problems.push({
				kind: 'foreign-pr',
				message: `${where} points at ${anchor.repo}#${anchor.number}, not ${repo}#${number}`,
			});
			continue;
		}
		const file = files.get(anchor.hash);
		if (!file) {
			if (!prFiles || !prFiles.complete) unverifiable = true;
			else problems.push({ kind: 'unknown-file', message: `${where} does not match a file in the current diff` });
			continue;
		}
		if (anchor.line == null) {
			problems.push({ kind: 'no-line', message: `${file.path} PR-diff link has no line anchor` });
			continue;
		}
		if (!file.patchAvailable) {
			unverifiable = true;
			continue;
		}
		for (const [side, line] of [
			[anchor.side, anchor.line],
			[anchor.endSide, anchor.endLine],
		])
			if (line != null && !withinAnyRange(file.ranges?.[side] ?? [], line))
				problems.push({
					kind: 'line-not-in-diff',
					message: `${file.path}${side}${line} is not in a current diff hunk`,
				});
	}
	return { ok: problems.length === 0 && !unverifiable, problems, anchors, lineAnchored, unverifiable };
}
