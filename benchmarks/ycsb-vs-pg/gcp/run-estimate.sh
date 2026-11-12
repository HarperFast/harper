#!/usr/bin/env bash
# The short estimate: does running Redis and Postgres on their own VMs (topology b) change the stack's
# numbers enough to put b in the full matrix? Provisions a run (both topologies), checks the generator
# is not the ceiling, runs a smoke pass, then harper-uws, pg-redis and pg-redis@b on C, inspect and
# chain-4, warm and 2x, token auth, 3 reps. Results are copied back after every phase; teardown runs on
# exit whatever happened, after one last copy.
#
#   YCSB_GCP_PROJECT=<project> YCSB_GCP_ZONE=<zone> gcp/run-estimate.sh [--run-id=<id>] [--commit=<sha>]
set -euo pipefail
. "$(dirname "$0")/config.sh"
: "${YCSB_GCP_PROJECT:?set YCSB_GCP_PROJECT}"
RUN_ID=""
PASS=()
for arg in "$@"; do
	case "$arg" in
	--run-id=*) RUN_ID="${arg#*=}" ;;
	--commit=*) PASS+=("$arg") ;;
	*)
		echo "unknown argument $arg" >&2
		exit 2
		;;
	esac
done
[ -n "$RUN_ID" ] || RUN_ID="ycsb-$(date -u +%Y%m%d-%H%M)-est-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
ycsb_check_run_id "$RUN_ID"
RUN_DIR="$YCSB_RUNS_DIR/$RUN_ID"
TARGETS=harper-uws,pg-redis,pg-redis@b
WORKLOADS=C,inspect,chain-4
COMMON="--hosts=/opt/ycsb/hosts.json --targets=$TARGETS --auth=token"
. "$YCSB_GCP_DIR/session.sh"

finish() {
	session_finish $?
	exit $?
}
"$YCSB_GCP_DIR/provision.sh" --run-id="$RUN_ID" --topology=ab "${PASS[@]}"
trap finish EXIT
session_init
SHARDS=$(choose_shards)
COMMON="$COMMON --shards=$SHARDS"

# Every code path once, at a size that takes minutes: both topologies, dependent reads, a write, a snapshot.
phase smoke-compare "node benchmarks/ycsb-vs-pg/run-compare.mts $COMMON --scale=quick --workloads=C,B,chain-4 --reps=1"
phase smoke-sweep "node benchmarks/ycsb-vs-pg/memory-sweep.mts $COMMON --ratios=0.002 --workloads=C,inspect --reps=1 \
	--warmup-chunk=20000 --warmup-max-chunks=3 --ops=20000"

phase warm "node benchmarks/ycsb-vs-pg/run-compare.mts $COMMON --workloads=$WORKLOADS --reps=3 --host-quiet-cores=1"
phase sweep-2x "node benchmarks/ycsb-vs-pg/memory-sweep.mts $COMMON --ratios=2 --workloads=$WORKLOADS --reps=3"
echo "estimate done: $RUN_DIR/results"
