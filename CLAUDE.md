# CLAUDE.md — MySpark+ / LitBiz

This file governs how you (Claude Code) work in this repo. Read it every session. When it conflicts with a casual request, this file wins. When in doubt, ask before acting.

## What this is

MySpark+ is a HIPAA-aligned SaaS CRM for healthcare clinics. Owner: Patrick (LitBiz Media). Production is live and serves real patient data.

- Frontend: single `index.html` (~25,000 lines, ~1.6MB, vanilla JS) on S3 + CloudFront
- Backend: AWS Lambda behind API Gateway HTTP API v2, in `api-aws/` by domain
- Shared libs: `lib-aws/`
- DB: RDS Postgres in VPC via RDS Proxy
- Auth: HttpOnly cookie sessions in RDS
- Email: Mailgun only (`lib-aws/mailgun.js`). BAA signed.
- Payments: Square
- Region: us-east-2. Account: 993939946677.

## How you work with Patrick

You execute commands yourself. You do not hand him bash to copy-paste. But you operate gated, not autonomous.

- State what you are about to do in one or two plain sentences before you do it.
- Run read-only recon freely (grep, view, git status, read-only DB queries, list-functions).
- STOP and get an explicit yes before any action that changes state. See the gate list below.
- Validate after every change. Never chain three untested edits.
- One logical change at a time. Confirm it works before the next.
- When a task turns out bigger than expected, say so. He values honesty over false confidence.
- Do not press him to take breaks. He manages his own time.

### Always confirm before (the gate)

- Deploying anything (S3 upload, `aws lambda update-function-code`, CloudFront invalidation)
- `git push`
- Any DB write, schema change, or migration
- Deleting files, dropping backups, or any destructive command
- Editing `index.html`, after showing the exact before/after string

Recon never needs confirmation. Mutation always does.

## Communication style

Spartan, active voice, short sentences. Address him as "you." No em dashes anywhere, use periods or commas. No markdown in UI copy you write (toasts, modals, buttons). Practical and direct, no preamble.

## index.html rules (highest risk)

This file is the most dangerous thing in the repo. One bad edit takes down production.

- NEVER read the whole file. It is 1.6MB. Grep for the target, read only the range you need.
- NEVER use broad regex to patch it. Patterns like `re.sub(r'db\.X\s*=\s*([^;]+);', ...)` match semicolons inside callbacks and corrupt code.
- ALWAYS use exact-string replacement with full unique surrounding context.
- After any patch, grep the patched lines and read them back visually before deploy. A naive validator that strips line continuations can mask real syntax errors.
- Validate JS parse before every deploy (see Deploy section).

## Shell rules (zsh on Mac)

Default shell is zsh. Default bash is 3.2 (no associative arrays, no `declare -A`).

- NEVER inline `node -e "..."` or `python3 -c "..."` containing `!`. zsh history expansion fires inside double quotes and can corrupt adjacent heredocs. Write the code to a `/tmp` file with a single-quoted delimiter (`cat > /tmp/x.js <<'EOF' ... EOF`), then run `node /tmp/x.js`.
- Bash blocks longer than ~10 lines or containing shell functions go to a `/tmp` script run via `bash /tmp/x.sh`, never inline. Inline complex blocks can clobber PATH.
- If PATH gets clobbered, recover with: `export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`
- Avoid `${!var[@]}` and similar bang patterns.

## AWS Lambda rules

- NEVER set env vars with `AWS_` prefix. Reserved by the runtime. Use `S3_BUCKET`, `KMS_KEY_ARN`, etc.
- NEVER pass explicit credentials to AWS SDK clients in Lambda. Let the SDK auto-discover. Passing `accessKeyId`/`secretAccessKey` drops the session token and breaks presigned URLs.
- Lambda names are inconsistent. ALWAYS verify the real name via `list-functions` before deploy:
  `aws lambda list-functions --region us-east-2 --query 'Functions[?contains(FunctionName, \`PATTERN\`)].FunctionName' --output text`
- HTTP API v2 routes that need CORS preflight use `ANY /path`, never `POST /path` alone. POST-only silently fails OPTIONS.
- HTTP API v2 sends cookies in `event.cookies` array, not `event.headers.cookie`. `lib-aws/lambda-adapter.js` handles this.

## JS correctness traps

- `value || default` is dangerous when 0 is valid. `allHours[0] || 8` returns 8 when the value is 0. Use a length check or `??`.
- pg returns DATE columns as JS Date objects, not strings. Detect at entry: if `d instanceof Date` use `d.toISOString().slice(0,10)`, else `String(d).slice(0,10)`. Concatenating `'T12:00:00'` onto a Date produces "Invalid Date" in emails.

## Architecture invariants (do not violate)

- Contacts: read and write via `lib-aws/contacts.js` only. NEVER read contacts from `subaccount_data.data.contacts`. That blob data is dead and stale.
- Coupons: use `lib-aws/coupons.js`. Redemptions log server-side only, in `payments-create` and `booking-submit`. NEVER log coupon usage from the frontend.
- Money: lives in RDS, never the blob. Follow `MySpark-Payment-Policy.md` for all payment math. Use `lib-aws/tax.js`, never inline tax math.
- Email: Mailgun via `lib-aws/mailgun.js`. No SES, no Resend.
- Patient-facing email: call `shouldSend(...)` from `lib-aws/notifications.js` before sending, unless intentionally ungated (manual conversations).
- Auth: use `requireSubaccountAuth` or `requireAgencyAuth`. Never roll your own session check.
- PHI endpoints: always `logAudit(...)` from `lib-aws/audit.js`. Read endpoints log `.view`, writes log `.create/.update/.delete`.
- User data: never mutate `db.users` directly and never write user fields to the blob. All user writes go through `/api/subaccount/update-user`.
- CSS: new styles reference design tokens (`var(--main-card)`, `var(--purple)`, etc.). No raw hex in new CSS. See `MySpark-Design-Tokens.docx`.

## Git discipline

- NEVER `git add .`. Stage specific paths only.
- NEVER put a PAT token in a remote URL. Auth is osxkeychain.
- Never commit `.lambda-builds/`, `.lambda-deps/`, `node_modules/`, or `.bak` files (gitignored).
- Commit clean states with descriptive messages after a confirmed deploy. Commit before deploying so revert is one step.
- Root files (`index.html`) go to repo root. API files go to their subfolder.

## Deploy patterns

### Frontend (index.html)
1. Validate JS parse (extract the main script, `vm.compileFunction`). Block deploy on parse error.
2. `aws s3 cp index.html s3://myspark-app-www/index.html --cache-control "no-cache, no-store, must-revalidate" --content-type "text/html" --region us-east-2`
3. Invalidate CloudFront `EELLOP01UKIZV` on paths `/index.html` and `/`
4. Wait ~30s. Tell Patrick to hard refresh (Cmd+Shift+R).

### Single Lambda
1. `node --check` the source file.
2. Build zip: source as `index.js`, `lib-aws/*.js` into `lib/`, copy `.lambda-deps/node_modules`, minimal `package.json`.
3. `aws lambda update-function-code` with the verified function name, then `aws lambda wait function-updated`.
4. Smoke test the endpoint with curl for the status code.

### Ad-hoc DB queries
Use the permanent `myspark-audit-db` Lambda. Write the query handler to `/tmp`, zip with `lib-aws/db.js`, update the function, invoke, read output. Do not delete this Lambda.

## Quick reference (us-east-2, account 993939946677)

- Frontend bucket: `myspark-app-www`
- Booking bucket: `myspark-booking-widget`
- Media bucket: `myspark-media-production`
- Main CloudFront: `EELLOP01UKIZV`
- Booking CloudFront: `EEEW01YA5I6AX`
- API custom domain: `api.mysparkplus.app` (API Gateway `mcky8646b6`)
- RDS Proxy host: `myspark-rds-proxy.proxy-cx04y668wmb4.us-east-2.rds.amazonaws.com`, db `myspark`, user `myspark_admin`
- Lambda role: `arn:aws:iam::993939946677:role/myspark-lambda-execution-role`
- SNS alerts: `arn:aws:sns:us-east-2:993939946677:myspark-alerts` (patrick@litbiz.io)
- Mailgun secret: `myspark/integrations/mailgun`

## Tail Lambda logs

`aws logs tail /aws/lambda/[FUNCTION_NAME] --region us-east-2 --since 5m --format short`
