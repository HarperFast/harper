#!/bin/bash
# harper#1864 schema-churn repro: build a 5.1.10 root with a multi-file GraphQL schema,
# reorder/relocate type declarations across many restarts (simulating real schema evolution
# history), concatenate to a single file, seed rows, then upgrade-boot to 5.2 and hammer the
# probe looking for a LONG-lived (not brief self-healing) broken point-read window.
set -u
rm -f ~/.harperdb/hdb_boot_properties.file 2>/dev/null
H5110=/home/kzyp/dev/tmp/hdb5110/node_modules/.bin/harper
H52=${H52:-/home/kzyp/dev/tmp/hdb52/node_modules/.bin/harper}
U=/home/kzyp/dev/tmp/churn-hdb
SOCK=$U/operations-server
HTTP_PORT=${HTTP_PORT:-39926}
OPS_PORT=${OPS_PORT:-39925}
RESTARTS=${RESTARTS:-15}
LOG=/home/kzyp/dev/tmp/churn-repro.log
: > $LOG
export DISPATCH_SECRET=local-test-secret-0123456789abcdef DISPATCH_GH_CLIENT_ID=test DISPATCH_GH_CLIENT_SECRET=test

kill_port(){ local p=$(ss -ltnp 2>/dev/null|grep ":$1"|grep -oE 'pid=[0-9]+'|head -1|cut -d= -f2); [ -n "$p" ] && kill -${2:-TERM} $p 2>/dev/null; for i in $(seq 1 12); do ss -ltn 2>/dev/null|grep -qE ":$1" || break; sleep 1; done; ss -ltn 2>/dev/null|grep -qE ":$1" && kill -9 $p 2>/dev/null; sleep 1; }

log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }

CHURN_SRC=/home/kzyp/dev/tmp/churn-app
# component dir layout mirrors probe-app: components/dispatch/{config.yaml, dispatch/*}
COMPONENTS=$U/components/dispatch/dispatch

# 9 self-contained type blocks (name -> content) pulled from the probe-app schema.
TYPES=(AgentBackend BoardItem PromptConfig Run Session Task TaskEvent User Worker)
declare -A BLOCK
BLOCK[AgentBackend]='type AgentBackend @table {
	id: ID @primaryKey
	name: String
	cliTemplate: String
	kinds: String
	enabled: Boolean
	notes: String
}'
BLOCK[BoardItem]='type BoardItem @table {
	id: ID @primaryKey
	user: String @indexed
	class: String @indexed
	repo: String
	num: Float
	title: String
	url: String
	detail: String
	whyHuman: String
	whyNotAuto: String
	updatedAt: Float
}'
BLOCK[PromptConfig]='type PromptConfig @table {
	id: ID @primaryKey
	user: String @indexed
	name: String @indexed
	value: String
	updatedAt: Float
	updatedBy: String
}'
BLOCK[Run]='type Run @table {
	id: ID @primaryKey
	task: String @indexed
	worker: String @indexed
	pid: Float
	slot: String
	agent: String
	model: String
	effort: String
	sessionId: String
	rcMode: String
	startedAt: Float
	finishedAt: Float
	rc: Float
	logTail: String
}'
BLOCK[Session]='type Session @table {
	id: ID @primaryKey
	user: String @indexed
	createdAt: Float
	expiresAt: Float @indexed
}'
BLOCK[Task]='type Task @table {
	id: ID @primaryKey
	user: String @indexed
	status: String @indexed
	kind: String
	repo: String @indexed
	issue: String
	pr: String
	base: String
	branch: String
	agent: String
	model: String
	effort: String
	priority: String @indexed
	rc: Boolean
	rcSession: String
	worker: String
	queuedAt: Float
	claimedAt: Float
	task: String
	context: String
	acceptance: String
	findings: String
}'
BLOCK[TaskEvent]='type TaskEvent @table {
	id: ID @primaryKey
	task: String @indexed
	ts: Float @indexed
	who: String
	body: String
}'
# User/Worker attribute order intentionally shuffled between rounds too (churn touches the
# exact tables the probe reads: User + Worker).
BLOCK_User_v1='type User @table {
	id: ID @primaryKey
	githubId: Float @indexed
	name: String
	email: String
	role: String
	ghTokenEncrypted: Bytes
	ghTokenScope: String
	createdAt: Float
}'
BLOCK_User_v2='type User @table {
	id: ID @primaryKey
	name: String
	githubId: Float @indexed
	role: String
	email: String
	createdAt: Float
	ghTokenEncrypted: Bytes
	ghTokenScope: String
}'
BLOCK_Worker_v1='type Worker @table {
	id: ID @primaryKey
	user: String @indexed
	host: String
	slots: Float
	version: String
	lastSeen: Float
	tokenHash: String
	enabled: Boolean
}'
BLOCK_Worker_v2='type Worker @table {
	id: ID @primaryKey
	host: String
	user: String @indexed
	enabled: Boolean
	slots: Float
	tokenHash: String
	version: String
	lastSeen: Float
}'

write_layout() {
	# $1 = round number; assigns each of the 9 types to one of 3 files via rotation
	# (pure type-declaration relocation churn; attribute order held constant so a
	# boot stall can be attributed to file relocation alone, not attribute reordering).
	local round=$1
	rm -f $COMPONENTS/schema-*.graphql
	local idx=0
	for t in "${TYPES[@]}"; do
		local file=$(( (idx + round) % 3 ))
		local content
		if [ "$t" = "User" ]; then content="$BLOCK_User_v1"
		elif [ "$t" = "Worker" ]; then content="$BLOCK_Worker_v1"
		else content="${BLOCK[$t]}"
		fi
		printf '%s\n\n' "$content" >> $COMPONENTS/schema-$file.graphql
		idx=$((idx+1))
	done
}

write_single_file_layout() {
	rm -f $COMPONENTS/schema-*.graphql
	{
		for t in "${TYPES[@]}"; do
			if [ "$t" = "User" ]; then echo "$BLOCK_User_v1"; echo
			elif [ "$t" = "Worker" ]; then echo "$BLOCK_Worker_v1"; echo
			else echo "${BLOCK[$t]}"; echo
			fi
		done
	} > $COMPONENTS/schema.graphql
}

seed() {
	local tag=$1
	curl -s --unix-socket $SOCK http://localhost -H 'content-type: application/json' \
		-d "{\"operation\":\"insert\",\"database\":\"data\",\"table\":\"User\",\"records\":[{\"id\":\"$tag\",\"name\":\"U-$tag\",\"role\":\"member\"}]}" >/dev/null
	curl -s --unix-socket $SOCK http://localhost -H 'content-type: application/json' \
		-d "{\"operation\":\"insert\",\"database\":\"data\",\"table\":\"Worker\",\"records\":[{\"id\":\"w-$tag\",\"user\":\"kriszyp\",\"host\":\"h-$tag\"}]}" >/dev/null
}

boot_5110() {
	local label=$1
	ROOTPATH=$U $H5110 run > /home/kzyp/dev/tmp/churn-5110-$label.log 2>&1 &
	echo $! > /tmp/churn-5110.pid
	for i in $(seq 1 120); do grep -qa "successfully started" /home/kzyp/dev/tmp/churn-5110-$label.log && return 0; sleep 1; done
	return 1
}

log "=== fresh 5.1.10 install at $U (ports $HTTP_PORT/$OPS_PORT) ==="
rm -rf $U
ROOTPATH=$U HDB_ADMIN_USERNAME=admin HDB_ADMIN_PASSWORD=password HTTP_PORT=$HTTP_PORT OPERATIONSAPI_NETWORK_PORT=$OPS_PORT $H5110 install > /home/kzyp/dev/tmp/churn-install.log 2>&1
grep -qa "installation was successful" /home/kzyp/dev/tmp/churn-install.log || { log "FAIL-INSTALL"; cat /home/kzyp/dev/tmp/churn-install.log; exit 1; }
mkdir -p $U/components
cp -r $CHURN_SRC $U/components/dispatch
rm -f $COMPONENTS/schema.graphql
sed -i 's/^    port: 1883/    port: 51883/' $U/harper-config.yaml

write_layout 0
log "--- round 0 (initial multi-file layout) boot ---"
boot_5110 "r0" || { log "FAIL-BOOT-r0"; cat /home/kzyp/dev/tmp/churn-5110-r0.log; exit 1; }
sleep 2
seed "seed-early-1"
log "seeded seed-early-1 at round 0"
kill_port $HTTP_PORT TERM

for r in $(seq 1 $RESTARTS); do
	write_layout $r
	log "--- round $r churn boot (types reshuffled across files) ---"
	boot_5110 "r$r" || { log "FAIL-BOOT-r$r"; tail -30 /home/kzyp/dev/tmp/churn-5110-r$r.log; kill_port $HTTP_PORT KILL; exit 1; }
	sleep 1.5
	seed "seed-mid-$r"
	log "seeded seed-mid-$r at round $r"
	kill_port $HTTP_PORT TERM
done

write_single_file_layout
log "--- final: concatenated to single schema.graphql, settling boot under 5.1.10 ---"
boot_5110 "final5110" || { log "FAIL-BOOT-final5110"; tail -30 /home/kzyp/dev/tmp/churn-5110-final5110.log; exit 1; }
sleep 2
seed "seed-final"
log "seeded seed-final; pre-upgrade probe (control):"
curl -s http://127.0.0.1:$HTTP_PORT/dispatch/storeprobe | tee -a $LOG
echo | tee -a $LOG
kill_port $HTTP_PORT TERM

log "=== 5.2 UPGRADE BOOT ==="
ROOTPATH=$U $H52 run > /home/kzyp/dev/tmp/churn-52.log 2>&1 &
echo $! > /tmp/churn-52.pid
for i in $(seq 1 50); do grep -qa "successfully started" /home/kzyp/dev/tmp/churn-52.log && break; sleep 1; done
sleep 2
log "=== hammering health/storeprobe (sub-second) for up to ${HAMMER_SECONDS:-180}s to check for a LONG-lived broken window ==="
START=$(date +%s%3N)
BROKEN_STREAK=0
MAX_BROKEN_STREAK=0
CAPTURES=0
while true; do
	NOW=$(date +%s%3N)
	ELAPSED_MS=$((NOW-START))
	[ $ELAPSED_MS -gt $(( (${HAMMER_SECONDS:-180}) * 1000 )) ] && break
	CODE=$(curl -s -o /tmp/churn-health-body.json -w '%{http_code}' http://127.0.0.1:$HTTP_PORT/dispatch/health)
	if [ "$CODE" = "503" ]; then
		BROKEN_STREAK=$((BROKEN_STREAK+1))
		[ $BROKEN_STREAK -gt $MAX_BROKEN_STREAK ] && MAX_BROKEN_STREAK=$BROKEN_STREAK
		log "t=${ELAPSED_MS}ms health=503 streak=$BROKEN_STREAK body=$(cat /tmp/churn-health-body.json)"
		# Capture the layer-by-layer entry/flags/version state WHILE still broken — this is the
		# empirical evidence the diagnosis needs, since the window self-heals and a post-hoc probe
		# only shows HIT. Cap total captures so a long window doesn't spam the log.
		if [ $CAPTURES -lt 40 ]; then
			log "storeprobe@t=${ELAPSED_MS}ms: $(curl -s http://127.0.0.1:$HTTP_PORT/dispatch/storeprobe)"
			CAPTURES=$((CAPTURES+1))
		fi
	else
		if [ $BROKEN_STREAK -ge 3 ]; then
			log "t=${ELAPSED_MS}ms health=$CODE — RECOVERED after streak=$BROKEN_STREAK checks"
		fi
		BROKEN_STREAK=0
	fi
	sleep 0.2
done
log "=== done hammering; max broken streak = ${MAX_BROKEN_STREAK}s ==="
log "=== final storeprobe snapshot ==="
curl -s http://127.0.0.1:$HTTP_PORT/dispatch/storeprobe | tee -a $LOG
echo | tee -a $LOG
log "leaving 5.2 instance running at $U (port $HTTP_PORT/$OPS_PORT) for further diagnosis if MAX_BROKEN_STREAK >= 60"
