#!/usr/bin/env bash
# Deletes a benchmark run's resources and fails unless none is left: VMs and disks by the run's label
# or their exact names, then the placement policy, firewall rules, subnet and network by the exact
# names provision.sh gives them (those resource types take no labels). Exact names, not a prefix: run
# ycsb-x must never match run ycsb-x-2. GCE's max-run-duration deletes the VMs on its own; this catches
# what it leaves.
#
#   YCSB_GCP_PROJECT=<project> gcp/teardown.sh <run-id>
#   YCSB_GCP_PROJECT=<project> gcp/teardown.sh --all --yes     every ycsb-bench VM and ycsb-* resource
#   gcp/teardown.sh --dry-run <run-id>
set -euo pipefail
. "$(dirname "$0")/config.sh"

RUN_ID=""
ALL=0
YES=0
for arg in "$@"; do
	case "$arg" in
	--all) ALL=1 ;;
	--yes) YES=1 ;;
	--dry-run) export YCSB_DRY_RUN=1 ;;
	-*)
		echo "unknown argument $arg" >&2
		exit 2
		;;
	*) RUN_ID="$arg" ;;
	esac
done
: "${YCSB_GCP_PROJECT:?set YCSB_GCP_PROJECT}"
P=(--project="$YCSB_GCP_PROJECT")
if [ "$ALL" = 1 ]; then
	[ "$YES" = 1 ] || {
		echo "--all deletes every VM labeled ycsb-bench=true and every resource named ycsb-* in $YCSB_GCP_PROJECT; add --yes" >&2
		exit 2
	}
	VMS='labels.ycsb-bench=true OR name ~ ^ycsb-'
	NAMED='name ~ ^ycsb-'
else
	ycsb_check_run_id "$RUN_ID"
	VMS="labels.ycsb-run=$RUN_ID OR name ~ ^$RUN_ID-($(ycsb_roles ab | tr ' ' '|'))\$"
	NAMED="name ~ ^$RUN_ID-(net|subnet|internal|ssh|compact)\$"
fi

# gcloud list, or nothing in a dry run (which prints the query).
ls_() {
	if [ "${YCSB_DRY_RUN:-0}" = 1 ]; then
		gc "$@" >&2
		return 0
	fi
	gcloud "$@"
}

ls_ compute instances list "${P[@]}" --filter="$VMS" --format='value(name,zone.basename())' |
	while read -r name zone; do
		[ -n "$name" ] && gc compute instances delete "$name" "${P[@]}" --zone="$zone" --delete-disks=all
	done
ls_ compute resource-policies list "${P[@]}" --filter="$NAMED" --format='value(name,region.basename())' |
	while read -r name region; do
		[ -n "$name" ] && gc compute resource-policies delete "$name" "${P[@]}" --region="$region"
	done
ls_ compute firewall-rules list "${P[@]}" --filter="$NAMED" --format='value(name)' |
	while read -r name; do
		[ -n "$name" ] && gc compute firewall-rules delete "$name" "${P[@]}"
	done
ls_ compute networks subnets list "${P[@]}" --filter="$NAMED" --format='value(name,region.basename())' |
	while read -r name region; do
		[ -n "$name" ] && gc compute networks subnets delete "$name" "${P[@]}" --region="$region"
	done
ls_ compute networks list "${P[@]}" --filter="$NAMED" --format='value(name)' |
	while read -r name; do
		[ -n "$name" ] && gc compute networks delete "$name" "${P[@]}"
	done
ls_ compute disks list "${P[@]}" --filter="$VMS" --format='value(name,zone.basename())' |
	while read -r name zone; do
		[ -n "$name" ] && gc compute disks delete "$name" "${P[@]}" --zone="$zone"
	done
if [ "${YCSB_DRY_RUN:-0}" = 1 ]; then exit 0; fi

left=""
for kind in "instances:$VMS" "disks:$VMS" "resource-policies:$NAMED" "firewall-rules:$NAMED" \
	"networks subnets:$NAMED" "networks:$NAMED"; do
	found=$(gcloud compute ${kind%%:*} list "${P[@]}" --filter="${kind#*:}" --format='value(name)')
	[ -z "$found" ] || left="$left ${kind%%:*}: $(echo $found)"
done
if [ -n "$left" ]; then
	echo "teardown left resources behind:$left" >&2
	exit 1
fi
echo "teardown ${RUN_ID:-(all runs)}: no labeled VMs or run-named resources left in $YCSB_GCP_PROJECT"
