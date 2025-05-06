export function euclideanSimilarity(a: number[], b: number[]): number {
	// Euclidean distance
	let distanceSquared = 0;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const va = a[i] || 0;
		const vb = b[i] || 0;
		distanceSquared += Math.pow(va - vb, 2);
	}
	return -Math.sqrt(distanceSquared);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	// Cosine similarity
	let dotProduct = 0;
	let magnitudeA = 0;
	let magnitudeB = 0;

	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const va = a[i] || 0;
		const vb = b[i] || 0;
		dotProduct += va * vb;
		magnitudeA += va * va;
		magnitudeB += vb * vb;
	}

	magnitudeA = Math.sqrt(magnitudeA);
	magnitudeB = Math.sqrt(magnitudeB);

	return dotProduct / (magnitudeA * magnitudeB || 1);
}
