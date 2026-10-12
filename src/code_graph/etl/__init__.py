"""The indexing pipeline that runs without the desktop: GitHub → graph.

    trigger ──▶ control.index_jobs ──▶ queue ──▶ worker ──▶ tenant_<slug>.*
    (daily schedule, GitHub push webhook, "Index now" in the app)

- `signing`  who may start a job: GitHub webhooks (per-connection secrets
             derived from one master secret) and the web app (signed requests)
- `jobs`     the job log in `control.index_jobs`: enqueue (deduplicated),
             claim, finish, and the schedule's fan-out
- `github`   resolve a branch to a commit and fetch that commit's tarball,
             extracted safely into a scratch directory — no git binary needed
- `worker`   run one job: fetch, index (incrementally when the repo is already
             in the graph), pin the connection to the indexed commit, clean up
- `aws_lambda` the AWS entry points (Function URL + schedule, and the SQS worker)

Nothing here executes code from an indexed repository: files are only read and
parsed, the same as the local indexer.
"""
