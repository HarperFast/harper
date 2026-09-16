# Harper HNSW vs pgvector

Recall-matched ANN comparison on SIFT. An approximate index can be made arbitrarily fast by
searching less of the graph, so queries/sec is only meaningful next to a measured recall. This
sweeps the search-time candidate list on both systems — Harper's per-query `ef`, pgvector's
`hnsw.ef_search` — and reports q/s against recall@10, which is the ann-benchmarks methodology.

    node benchmarks/vector-vs-pgvector/run-compare.mts --records=200000 --queries=500

Both targets are confined to the same CPU set (`--serverCpus`, default `0-5`) and efficiency is
reported per CPU-gigacycle, because CPU-seconds are not comparable across runs on a machine whose
clock moves. Pin the clock before trusting any absolute number:

    sudo cpupower frequency-set -u 2.0GHz

## Dataset

SIFT1M (`ftp://ftp.irisa.fr/local/texmex/corpus/sift.tar.gz`), extracted to
`$VECTOR_DATA_DIR` (default `/home/kzyp/dev/tmp/vecdata/sift`). Real descriptors rather than
synthetic vectors: random high-dimensional points are near-equidistant, so recall stops
discriminating between a good index and a bad one. Ground truth is recomputed for whatever
subset is used — the shipped ground truth is relative to the full 1M base and would silently
score against neighbours that are not in the index.

## Known asymmetries, which the results have to be read against

- **Build strategy.** pgvector bulk-builds the index after loading, parallelised across
  maintenance workers. Harper indexes on write. Only the load+index total is comparable, and
  the flip side of Harper's cost is that its index is never stale.
- **Vector precision.** Harper int8 scalar-quantizes and reranks candidates on exact distances;
  pgvector stores float32 in the index. Harper's index is smaller; the rerank costs a full
  record load per candidate (`resources/search.ts`), which is why Harper's cost grows with `ef`
  while pgvector's barely does.
- **Ingest path.** Harper loads over REST (one PUT per vector), pgvector over `COPY`. HTTP is
  under 1% of Harper's per-vector cost at these rates, so this does not explain the build gap.
