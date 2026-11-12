#!/usr/bin/env bash
# The full comparison matrix, topology (a): harper-uws, harper (Node's HTTP server) and pg-redis on workloads C,
# B, inspect, chain-1, chain-2, chain-4 and F, at warm, 2x and 8x, --auth=token, 3 reps per cell, targets
# interleaved within each session. One set is one session on a VM set of its own (generator, harper and stack
# VMs); the sets run in parallel, because one VM set would take about a day:
#
#   warm        run-compare, every workload; then perf profiles of warm C and chain-4 (harper-uws, pg-redis)
#   2x          memory-sweep --ratios=2, every workload
#   8x-cbf      memory-sweep --ratios=8, C, B and F           (8x is split three ways: each sample restores
#   8x-inspect  memory-sweep --ratios=8, inspect and chain-1   a 138 GiB Harper snapshot at local-SSD write
#   8x-chain    memory-sweep --ratios=8, chain-2 and chain-4   speed; each split loads its own snapshot)
#
# Each engine's dataset is loaded once per VM set and point, and every sample of the set restores it. Every
# set checks the generator's ceiling first and runs a smoke pass of its own phases at a size that takes
# minutes. Results come back to runs/<id>/results after every phase and every 10 minutes; teardown runs on
# exit, after one last copy, and fails unless nothing of the run is left.
#
#   YCSB_GCP_PROJECT=<project> gcp/run-matrix.sh --set=<set> [--run-id=<id>] [--resume] [--commit=<sha>]
#   YCSB_GCP_PROJECT=<project> gcp/run-matrix.sh --all [--base=<id>] [--resume] [--commit=<sha>]
#   gcp/run-matrix.sh --plan                 the sets, with the shapes and deadlines they would get
#   gcp/run-matrix.sh --set=<set> --dry-run  the gcloud commands provisioning that set would run
#
# --all starts every set (run id <base>-<set>) and waits for all of them; each set's output goes to
# runs/<base>-<set>.log. --resume (with --run-id, or --base for --all) picks a set up where it stopped when its
# orchestrator died without tearing down (a host crash, SIGKILL): it provisions nothing, and each phase that
# already ended is read, not run again. A set whose VMs are gone is provisioned again, its old run directory
# kept as <id>.attempt-<n>; a set that finished (runs/<id>/done) is skipped. Without --resume an existing run
# directory is refused, and a run whose orchestrator is alive (it holds runs/<id>.lock) is never taken over.
# Run the orchestrator where the operator's session ending does not signal it (systemd-run --user): any exit
# it sees tears the run down.
set -euo pipefail
# The operator's own shape and deadline, if given, win over a set's: read before config.sh fills its defaults.
GEN_OVERRIDE="${YCSB_GEN_MACHINE_TYPE:-}"
MAX_RUN_OVERRIDE="${YCSB_MAX_RUN_DURATION:-}"
. "$(dirname "$0")/config.sh"

SETS="warm 2x 8x-cbf 8x-inspect 8x-chain"
TARGETS=harper-uws,harper,pg-redis
ALL_WORKLOADS=C,B,inspect,chain-1,chain-2,chain-4,F

# Per set: point, workloads, generator shape, GCE's deletion deadline. A generator is checked against its own
# ceiling before anything is measured; the 2x and 8x targets serve well under the warm ones.
set_point() { case "$1" in warm) echo warm ;; 2x) echo 2 ;; 8x-*) echo 8 ;; esac; }
set_workloads() {
	case "$1" in
	warm | 2x) echo "$ALL_WORKLOADS" ;;
	8x-cbf) echo C,B,F ;;
	8x-inspect) echo inspect,chain-1 ;;
	8x-chain) echo chain-2,chain-4 ;;
	esac
}
set_generator() {
	[ -z "$GEN_OVERRIDE" ] || {
		echo "$GEN_OVERRIDE"
		return
	}
	case "$1" in warm) echo c4-standard-32 ;; *) echo c4-standard-16 ;; esac
}
set_max_run() {
	[ -z "$MAX_RUN_OVERRIDE" ] || {
		echo "$MAX_RUN_OVERRIDE"
		return
	}
	case "$1" in warm) echo 10h ;; *) echo 16h ;; esac
}

SET="" RUN_ID="" BASE="" ALL=0 RESUME=0 PLAN=0 DRY=0
PASS=()
for arg in "$@"; do
	case "$arg" in
	--set=*) SET="${arg#*=}" ;;
	--run-id=*) RUN_ID="${arg#*=}" ;;
	--base=*) BASE="${arg#*=}" ;;
	--all) ALL=1 ;;
	--resume) RESUME=1 ;;
	--plan) PLAN=1 ;;
	--dry-run) DRY=1 ;;
	--commit=*) PASS+=("$arg") ;;
	*)
		echo "unknown argument $arg" >&2
		exit 2
		;;
	esac
done

if [ "$PLAN" = 1 ]; then
	for s in $SETS; do
		printf '%-11s point %-4s generator %-15s max-run %-4s workloads %s\n' "$s" "$(set_point "$s")" \
			"$(set_generator "$s")" "$(set_max_run "$s")" "$(set_workloads "$s")"
	done
	exit 0
fi

# A run lasts most of a day, longer than a user login's gcloud token: it runs as a service account from a
# gcloud configuration directory of its own, never from the default one, ADC or a user account.
check_account() {
	local account
	[ -n "${CLOUDSDK_CONFIG:-}" ] || {
		echo "set CLOUDSDK_CONFIG to the matrix's own gcloud directory (gcloud auth activate-service-account there)" >&2
		return 1
	}
	account=$(gcloud config get-value account 2>/dev/null)
	case "$account" in
	*.iam.gserviceaccount.com) echo "gcloud account: $account ($CLOUDSDK_CONFIG)" ;;
	*)
		echo "the active gcloud account in $CLOUDSDK_CONFIG is '${account:-none}', not a service account" >&2
		return 1
		;;
	esac
}

if [ "$ALL" = 1 ]; then
	: "${YCSB_GCP_PROJECT:?set YCSB_GCP_PROJECT}"
	[ -z "$SET$RUN_ID" ] || {
		echo "--all names its sets and run ids itself; use --base" >&2
		exit 2
	}
	[ "$DRY" = 0 ] || {
		echo "--dry-run previews one set (--set=<set>); --plan lists them all" >&2
		exit 2
	}
	if [ "$RESUME" = 1 ] && [ -z "$BASE" ]; then
		echo "--all --resume needs the --base of the matrix to resume" >&2
		exit 2
	fi
	check_account
	[ -n "$BASE" ] || BASE="ycsb-$(date -u +%Y%m%d-%H%M)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
	ycsb_check_run_id "$BASE-8x-inspect"
	mkdir -p "$YCSB_RUNS_DIR"
	pids=()
	for s in $SETS; do
		args=(--set="$s" --run-id="$BASE-$s" "${PASS[@]}")
		[ "$RESUME" = 1 ] && args+=(--resume)
		echo "starting $BASE-$s (log: $YCSB_RUNS_DIR/$BASE-$s.log)"
		"$0" "${args[@]}" >>"$YCSB_RUNS_DIR/$BASE-$s.log" 2>&1 &
		pids+=("$!")
		# Spreads the API calls and the zone-capacity requests of five provisionings.
		sleep "${YCSB_SET_STAGGER_S:-20}"
	done
	failed=""
	i=0
	for s in $SETS; do
		if wait "${pids[$i]}"; then echo "$BASE-$s: done"; else
			echo "$BASE-$s: FAILED (see $YCSB_RUNS_DIR/$BASE-$s.log)" >&2
			failed="$failed $s"
		fi
		i=$((i + 1))
	done
	[ -z "$failed" ] || {
		echo "matrix $BASE: failed sets:$failed; resume with: $0 --all --base=$BASE --resume" >&2
		exit 1
	}
	echo "matrix $BASE done: $YCSB_RUNS_DIR/$BASE-*/results"
	exit 0
fi

: "${YCSB_GCP_PROJECT:?set YCSB_GCP_PROJECT}"
case " $SETS " in
*" $SET "*) ;;
*)
	echo "--set must be one of: $SETS" >&2
	exit 2
	;;
esac
if [ "$RESUME" = 1 ] && [ -z "$RUN_ID" ]; then
	echo "--resume needs the --run-id of the set to resume" >&2
	exit 2
fi
export YCSB_GEN_MACHINE_TYPE YCSB_MAX_RUN_DURATION
YCSB_GEN_MACHINE_TYPE=$(set_generator "$SET")
YCSB_MAX_RUN_DURATION=$(set_max_run "$SET")
if [ "$DRY" = 1 ]; then
	exec "$YCSB_GCP_DIR/provision.sh" --dry-run --run-id="${RUN_ID:-ycsb-dry-run-$SET}" --topology=a "${PASS[@]}"
fi
check_account
[ -n "$RUN_ID" ] || RUN_ID="ycsb-$(date -u +%Y%m%d-%H%M)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')-$SET"
ycsb_check_run_id "$RUN_ID"
RUN_DIR="$YCSB_RUNS_DIR/$RUN_ID"
if [ -f "$RUN_DIR/done" ]; then
	echo "$RUN_ID finished already ($RUN_DIR/done)"
	exit 0
fi
POINT=$(set_point "$SET")
WORKLOADS=$(set_workloads "$SET")
. "$YCSB_GCP_DIR/session.sh"

finish() {
	session_finish $?
	exit $?
}

if [ -e "$RUN_DIR" ] && [ "$RESUME" != 1 ]; then
	echo "$RUN_DIR exists: pass --resume to continue that run, or pick another run id" >&2
	exit 2
fi
mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"
# One orchestrator per run: a second one would poll the same phases and tear the run down when it exits. The
# lock is held on fd 9 for this process's life (flock(1), Linux), so a crashed orchestrator releases it. It is
# beside the run directory, not in it, so archiving an earlier attempt never swaps the file the lock is on.
claim_run() {
	command -v flock >/dev/null || {
		echo "run-matrix.sh needs flock(1) (util-linux) to own its run" >&2
		exit 1
	}
	exec 9>>"$YCSB_RUNS_DIR/$RUN_ID.lock"
	flock -n 9 || {
		echo "$RUN_ID is driven by pid $(cat "$RUN_DIR/orchestrator.pid" 2>/dev/null || echo unknown); stop it first" >&2
		exit 1
	}
	echo $$ >"$RUN_DIR/orchestrator.pid"
}
claim_run
provisioned=0
if [ -s "$RUN_DIR/zone" ] && [ -s "$RUN_DIR/known_hosts" ]; then
	vms=$(gcloud compute instances list --project="$YCSB_GCP_PROJECT" --filter="labels.ycsb-run=$RUN_ID" --format='value(name)' | wc -l | tr -d ' ')
	if [ "$vms" -eq 3 ]; then
		echo "resuming $RUN_ID on its VMs in $(cat "$RUN_DIR/zone")"
		provisioned=1
	else
		echo "$RUN_ID has $vms of its 3 VMs; tearing down what is left and provisioning it again" >&2
		"$YCSB_GCP_DIR/teardown.sh" "$RUN_ID"
	fi
fi
if [ "$provisioned" = 0 ]; then
	# Whatever an earlier attempt left (results, logs, keys) is kept beside the new attempt, not mixed into it.
	if [ -n "$(ls -A "$RUN_DIR" | grep -vx orchestrator.pid || true)" ]; then
		n=1
		while [ -e "$RUN_DIR.attempt-$n" ]; do n=$((n + 1)); done
		mv "$RUN_DIR" "$RUN_DIR.attempt-$n"
		mkdir -m 700 "$RUN_DIR"
		mv "$RUN_DIR.attempt-$n/orchestrator.pid" "$RUN_DIR/"
		echo "kept the earlier attempt's directory as $RUN_DIR.attempt-$n"
	fi
	"$YCSB_GCP_DIR/provision.sh" --run-id="$RUN_ID" --topology=a "${PASS[@]}"
fi
trap finish EXIT
jq -n --arg set "$SET" --arg point "$POINT" --arg targets "$TARGETS" --arg workloads "$WORKLOADS" \
	--arg generator "$YCSB_GEN_MACHINE_TYPE" --arg maxRun "$YCSB_MAX_RUN_DURATION" \
	'{set: $set, point: $point, targets: ($targets | split(",")), workloads: ($workloads | split(",")),
	  generator: $generator, maxRunDuration: $maxRun, reps: 3, auth: "token", topology: "a"}' >"$RUN_DIR/set.json"
session_init
SHARDS=$(choose_shards)
COMMON="--hosts=/opt/ycsb/hosts.json --targets=$TARGETS --auth=token --shards=$SHARDS"
COMPARE="node benchmarks/ycsb-vs-pg/run-compare.mts"
SWEEP="node benchmarks/ycsb-vs-pg/memory-sweep.mts"

if [ "$POINT" = warm ]; then
	# The smoke pass profiles too: remote profiling is otherwise first exercised hours in.
	phase smoke-compare "$COMPARE $COMMON --scale=quick --workloads=C,B,chain-4,F --reps=1 \
		--profile=$REMOTE_RESULTS/smoke-profiles --profile-ops=20000"
	phase warm "$COMPARE $COMMON --workloads=$WORKLOADS --reps=3 --host-quiet-cores=1"
	# Profiles after the measured cells, on the same VMs: the profiler's V8 flags change what they measure.
	phase profile "$COMPARE --hosts=/opt/ycsb/hosts.json --targets=harper-uws,pg-redis --auth=token --shards=$SHARDS \
		--workloads=C,chain-4 --reps=1 --host-quiet-cores=1 --profile=$REMOTE_RESULTS/profiles"
else
	phase smoke-sweep "$SWEEP $COMMON --ratios=0.002 --workloads=$WORKLOADS --reps=1 \
		--warmup-chunk=20000 --warmup-max-chunks=3 --ops=20000"
	phase "sweep-${POINT}x" "$SWEEP $COMMON --ratios=$POINT --workloads=$WORKLOADS --reps=3"
fi
date -u +%Y-%m-%dT%H:%M:%SZ >"$RUN_DIR/done"
echo "$RUN_ID done: $RUN_DIR/results"
