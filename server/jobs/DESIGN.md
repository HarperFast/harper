## A job row is settled by exactly one of two mechanisms, chosen by who is still alive (`server/jobs/`)

A job's terminal status is written by the worker itself (`jobProcess.ts`), so a worker that dies first
leaves the row at `CREATED`/`IN_PROGRESS` forever. Two mechanisms settle those rows, and the split is by
what survived the death, not by what killed it:

- The **process** is gone — crash, `restart`, `HARPER_EXIT_ON_RESTART` under an orchestrator. The next
  boot's `reconcileInterruptedJobs()` claims every unfinished row whose `owner_instance` is not this
  process's, which is all of them (harper#2635).
- The **thread** is gone but the process is not. The boot sweep cannot see these: the row still carries
  the running process's own `owner_instance`, and the sweep only runs at boot. `startJobWorker`'s exit
  hook settles them instead, via `settleAbandonedJob()`.

Ownership is a per-boot uuid rather than a pid because pids are reused, and a reused pid would make a
dead job look alive. Both mechanisms report an interrupted row as `ERROR` rather than a new status, because
every existing `get_job` consumer already handles `ERROR`; the distinction lives in the message.

The exit hook uses `startWorker`'s `onUnexpectedExit` option for every exit the worker makes on its
own, a finished job's included, and its `onPermanentStop` option for a deliberate stop with no
replacement while the process stays alive. `settleAbandonedJob()` re-reads the row, so a job that
wrote its own terminal status is left alone. A restart through `startCopy()` does not settle the row,
because the replacement re-runs the job from its stored request; that re-run predates this hook, and
it repeats any effects the first run applied. Process teardown leaves the row to the boot sweep. A
settle that fails is logged and not retried in-process; the next boot's sweep claims the row. These are **options** rather than listeners the caller attaches to the
returned worker because `startCopy()` restarts through the same options object: a listener bound to the
first worker never reaches the replacements, which can die the same way.
