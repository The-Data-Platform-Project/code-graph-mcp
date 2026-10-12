# Cloud indexer on AWS, deployed by GitHub Actions

How connected GitHub repositories get indexed without the desktop: once a day,
on every push, and when someone presses **Index now** on `/settings`. The code
is `src/code_graph/etl/`; the infrastructure is `infra/aws/`; the deploys are
`.github/workflows/`. Operating the web app is in [ADMIN_GUIDE.md](ADMIN_GUIDE.md).

---

## How it fits together

```
 GitHub push ──webhook──┐        (or .github/workflows/index-on-push.yml)
 /settings "Index now" ─┼──▶ Lambda Function URL ─┐
 EventBridge Scheduler ─┘   (TriggerFunction)     │  verifies the signature,
     daily, 03:00 SGT                             │  writes control.index_jobs,
                                                  ▼  sends {job_id}
                                           SQS queue ──(2 tries)──▶ dead-letter queue
                                                  │
                                                  ▼
                                    WorkerFunction (1 GB, 15 min max)
                         resolve branch → commit, download that commit's tarball
                         with the connection's fine-grained token, index into
                         tenant_<slug> (incremental if already there), pin
                         previews to the commit, delete the copy
                                                  │
                                                  ▼
                                      Supabase Postgres (session pooler)
```

- **Jobs live in Postgres.** `control.index_jobs` records every run: trigger,
  status, commit, error, counts. SQS only carries the job id, so a duplicate
  or late message is harmless: claiming a job is a conditional `UPDATE`.
- **At most one queued run per repository.** A burst of pushes collapses into
  one run, which indexes whatever the branch points at when it starts.
- **Unchanged commits are skipped.** The daily run costs one GitHub API call
  per repository when nothing was pushed.
- **No git, no execution.** The worker streams the tarball, writes regular
  files only (no symlinks, nothing outside its scratch directory, nothing over
  the size cap) and parses them. Nothing from a repository is ever run.

### Who may start a run

One secret, `INDEXER_SECRET`, shared by the web app and the indexer:

| Caller | Proof | Scope |
|---|---|---|
| GitHub webhook / Actions workflow | `X-Hub-Signature-256` with the connection's own secret, `HMAC(INDEXER_SECRET, "webhook:<tenant>:<repo>")` | that one connection |
| Web app ("Index now") | `X-CG-Signature` over timestamp and body; refused after 5 minutes | the named connection |
| EventBridge Scheduler | invokes the function directly (IAM), not through the URL | every connection with *daily* on |

A tenant can see their own connection's webhook secret on `/settings`; it
cannot sign anything for another tenant or another repository.

---

## What it costs

Everything is inside AWS's **always-free** allowances at personal scale. Worked
example: 10 repositories, each re-indexed daily plus 30 pushes a day in total,
30 seconds a run at 1 GB:

| Service | Use per month | Free allowance | Cost |
|---|---|---|---|
| Lambda (worker + trigger) | ~1,200 runs, ~36,000 GB-seconds | 1M requests, 400,000 GB-s | $0 |
| SQS | Lambda's long polling, ~0.65M requests | 1M requests | $0 |
| EventBridge Scheduler | 30 invocations | 14M | $0 |
| SSM Parameter Store (standard) | 4 parameters | free tier | $0 |
| CloudWatch Logs | well under 1 GB, kept 14 days | 5 GB ingest | $0 |
| ECR | 1 image (~0.4 GB), last 3 kept | 500 MB for 12 months, then $0.10/GB | ≤ $0.05 |
| S3 (deploy artifacts) | kilobytes, expired after 30 days | — | ≈ $0 |

So the $100 of credits is effectively untouched; they would cover the ECR
storage for decades. Secrets Manager ($0.40 per secret a month), NAT gateways,
VPCs and always-on containers are deliberately not used.

**GitHub Actions:** CI runs on every push (~4 minutes), the deploy only when
indexer code changes on `main` (~6 minutes). Unlimited for public repositories;
private ones get 2,000 free minutes a month.

---

## One-time setup

Region: **ap-southeast-1** (Singapore), next to Supabase and Vercel's `sin1`.
Run the AWS commands in **AWS CloudShell** (console, top bar), which is already
signed in. Everything else follows from the GitHub workflow.

### 1. Mint the two shared secrets

On your machine (WSL):

```bash
openssl rand -hex 32    # GITHUB_TOKEN_KEY: encrypts stored GitHub tokens
openssl rand -hex 32    # INDEXER_SECRET:   signs index requests, derives webhook secrets
```

Both values go to **two** places: the web app (Vercel) and SSM (next step).
They must match. Changing `GITHUB_TOKEN_KEY` later makes every stored GitHub
token unreadable (people re-add them); changing `INDEXER_SECRET` invalidates
every webhook secret (re-register the webhooks).

### 2. Store the indexer's settings in SSM

In CloudShell. The database URL is the **session pooler** (port 5432, IPv4),
as the database owner, because the indexer creates tenant schemas:

```bash
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /code-graph/database-url \
  --value 'postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require'
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /code-graph/github-token-key --value '<GITHUB_TOKEN_KEY>'
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /code-graph/indexer-secret --value '<INDEXER_SECRET>'
# Recommended: verify the database's certificate, not just encrypt.
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /code-graph/database-ca-cert --value "$(cat prod-ca-2021.crt)"
```

(Upload Supabase's CA file to CloudShell first: *Actions → Upload file*.
Standard SecureString parameters are free and encrypted with the AWS-managed
key.) To change one later, re-run with `--overwrite`; Lambdas pick it up on
their next cold start.

### 3. Deploy the bootstrap stack

Upload `infra/aws/bootstrap.yaml` to CloudShell, then:

```bash
aws cloudformation deploy --region ap-southeast-1 \
  --stack-name code-graph-bootstrap \
  --template-file bootstrap.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubRepository=The-Data-Platform-Project/code-graph-mcp
aws cloudformation describe-stacks --region ap-southeast-1 \
  --stack-name code-graph-bootstrap --query 'Stacks[0].Outputs' --output table
```

If the account already has GitHub's OIDC provider (from another project), add
`CreateOidcProvider=false` to the overrides.

It creates: GitHub's OIDC identity provider, a **deploy role** that only
workflows on this repository's `main` branch can assume (no AWS keys stored in
GitHub), an ECR repository that keeps the last 3 images, and a private S3
bucket for deploy artifacts that expires them after 30 days.

### 4. Tell GitHub about it

Repository → **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | bootstrap output `DeployRoleArn` |
| `AWS_IMAGE_REPOSITORY` | bootstrap output `ImageRepositoryUri` |
| `AWS_ARTIFACTS_BUCKET` | bootstrap output `ArtifactsBucketName` |
| `AWS_REGION` | `ap-southeast-1` (the default) |
| `INDEXER_ALARM_EMAIL` | optional: emailed when a job crashes twice |
| `APP_DB_ROLE` | optional: `codegraph_app`, so each deploy re-applies its grants |

Optional **secret** `MIGRATE_DATABASE_URL`: the same owner URL as
`/code-graph/database-url`. With it, every deploy first runs
`scripts/migrate_control.py` (idempotent), so control-plane changes reach the
database before the code that needs them.

### 5. Deploy

**Actions → Deploy indexer → Run workflow** (afterwards it runs by itself on
every push to `main` that touches the indexer). It runs CI, builds the image,
pushes it to ECR and deploys the `code-graph-indexer` stack. The run's summary
shows the outputs; `IndexerUrl` is what the app needs.

### 6. Point the web app at it

On Vercel (Production), then redeploy:

| Variable | Value |
|---|---|
| `INDEXER_URL` | the `IndexerUrl` output |
| `INDEXER_SECRET` | from step 1 |
| `GITHUB_TOKEN_KEY` | from step 1 |

`/settings` now shows **Index now** and **Webhook** on each repository.

### 7. Check it

```bash
curl https://<IndexerUrl>/health              # {"status": "ok"}
```

Then on `/settings`, **Index now** on a repository: the run appears under
**Recent index runs**, goes *queued → running → succeeded*, and the explorer
shows the new graph.

---

## Triggers per repository

- **Daily:** on for every connection unless *daily* is unticked. Change the
  time with the `DailyScheduleExpression` / `ScheduleTimezone` parameters.
- **On push, by webhook:** **Webhook** on `/settings` registers it with the
  connection's token (needs *Webhooks: read and write* on the token). Without
  that permission it shows the payload URL and secret to add by hand
  (*repository → Settings → Webhooks → Add webhook*, content type
  `application/json`, just the push event).
- **On push, by GitHub Actions:** for repositories where you cannot add
  webhooks, copy `.github/workflows/index-on-push.yml` into the repository and
  set its `INDEXER_URL` variable and `CODE_GRAPH_WEBHOOK_SECRET` secret (the
  connection's secret from `/settings`). It sends the same signed request a
  webhook would.
- **On demand:** **Index now**.

Only pushes to the connection's branch (its default branch unless one is set)
start a run.

---

## Operating it

| Task | How |
|---|---|
| See what ran | `/settings` → Recent index runs, or `SELECT * FROM control.index_jobs ORDER BY id DESC LIMIT 20;` |
| Worker logs | CloudWatch → Log groups → `/code-graph/code-graph-indexer/worker` (14 days) |
| A job crashed (timeout, out of memory) | It is retried once, then parked in the dead-letter queue (and emailed, if `INDEXER_ALARM_EMAIL` is set). The next daily run marks it failed. Raise `WorkerMemoryMB`, or exclude the repository. |
| Run every daily job now | Lambda console → TriggerFunction → Test with `{"source": "schedule"}` |
| Pause all indexing | EventBridge Scheduler → disable the schedule; untick *on push* where needed |
| Change memory or concurrency | parameters `WorkerMemoryMB` (default 1024) and `WorkerConcurrency` (default 2, the most runs at once) |
| Tear it all down | delete the `code-graph-indexer` stack, then `code-graph-bootstrap` (empty its bucket and ECR repository first), then the `/code-graph/*` parameters |

**Limits.** A run has 15 minutes and 2 GB of scratch disk; repositories over
2 GB of indexable files are refused. Files over 1.5 MB are skipped, as locally.
`WorkerConcurrency` keeps runs from exhausting Supabase's pooler connections.
