export function euclideanDistance(a: number[], b: number[]): number {
	// Euclidean distance
	if (!Array.isArray(a) || !Array.isArray(b)) {
		throw new Error('Euclidean distance comparison requires an array');
	}
	let distanceSquared = 0;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const va = a[i] || 0;
		const vb = b[i] || 0;
		const distance = va - vb;
		distanceSquared += distance * distance;
	}
	return distanceSquared; // technically distance is the square root, but skipping that doesn't change the order
}

export function cosineDistance(a: number[], b: number[]): number {
	// Cosine similarity, negated so it can be a "distance" function
	if (!Array.isArray(a) || !Array.isArray(b)) {
		throw new Error('Cosine distance comparison requires an array');
	}
	let dotProduct = 0;
	let magnitudeA = 0;
	let magnitudeB = 0;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const va = a[i] || 0;
		const vb = b[i] || 0;
		dotProduct += va * vb;
		magnitudeA += va * va;
		magnitudeB += vb * vb;
	}

	magnitudeA = Math.sqrt(magnitudeA);
	magnitudeB = Math.sqrt(magnitudeB);

	return 1 - dotProduct / (magnitudeA * magnitudeB || 1);
}
