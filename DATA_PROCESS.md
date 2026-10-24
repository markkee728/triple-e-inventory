# Data validation and release process

## Required gates

Every browser/API/automation operation follows its applicable gates:

1. Collect only necessary fields and identify the source and actor.
2. Authenticate the session or provider callback. Enforce role and record ownership.
3. Validate types, required fields, formats, bounds, precision and allowed states on the server.
4. Normalize documented decimal, email, phone and text formats; use parameterized SQL.
5. Check active references, authoritative prices, current stock and approved payment terms.
6. Record approval separately when required. Pending requests must not post stock or confirmed payments.
7. Lock affected records and recheck mutable rules inside a transaction. Persist business changes, ledger and audit together; roll everything back on failure.
8. Recheck replay references after acquiring the lock. Retries return the original result; a payment request reference cannot be reused for another order/quotation.
9. Acknowledge after commit, then send notifications. Delivery failures must not repeat financial or stock effects.
10. Restrict reads/exports, review audit history, back up privately, verify restores and apply an approved retention policy.

### Data-specific rules

| Data | Enforced boundary |
|---|---|
| Accounts | Customer registration cannot choose a staff role; staff invitations require Finance. Consent, password hashing, verification, OTP, revoked sessions and ownership remain enforced. |
| Products and movements | Finite numeric scalars and plain decimal strings only; existing bounds and decimal precision remain enforced. New raw materials use aluminum/brass categories; finished goods use pcs. Supplier receipts validate cost type. Production uses its dedicated confirmation flow. |
| Production | Validate output and actual material quantities before posting. Insufficient materials or failed audit writes roll back all materials, output and production records. A repeated confirmation key produces once. |
| Quotes | Existing specification/MOQ/date/approval rules remain. A required initial payment cannot be deferred to COD by online acceptance. Customer chooses online payment; accepting starts checkout but never marks the quote paid. Walk-in acceptance retains its existing path. |
| Payments/refunds | Only confirmed money enters the ledger. Decimal types are validated before coercion; formatted peso inputs retain commas/peso signs. Existing centavo rounding is preserved. Parent row locks, unique references, refund/overpayment limits and atomic audit protect balances. |
| Stock counts and cash shifts | Existing count/recount/Finance-posting and open/current-shift requirements remain in force. Counts and shift closure must follow their documented approval and discrepancy rules. |

## Release checks

Run from `backend/`:

```bash
npm run test:security
npm run test:data-integrity
npm audit --omit=dev --audit-level=high
npm run check:production
```

`test:data-integrity` requires a non-root user and installed PostgreSQL server/client tools. `pg_config --bindir` locates them; `POSTGRES_BIN` can specify their directory. The test creates a private temporary cluster, allows only a private Unix socket, uses synthetic records, verifies real concurrent stock/payment/production behavior, and performs pg_dump/restore with count comparisons. It stops and deletes its cluster on completion. It never uses `DATABASE_URL` or an existing database. It mounts the affected production/payment modules with core migrations and their required startup columns; it is not a complete production startup test.

`check:production` is a read-only configuration gate; it reads `backend/.env` and environment overrides without printing values or contacting providers. It checks production mode, secret length/placeholders, OTP/verification/cookie overrides, HTTPS application URL, proxy hop format, database configuration and a CA file for remote database TLS. Existing startup behavior is unchanged. Run this command in the actual deployment environment before release. Passing does not verify network reachability, certificate validity, actual delivery, encryption at rest or the proxy topology.

## Backup and recovery

- Use a dedicated backup directory owned by the account running the job, with no permissions for group/others. New directories/files are created privately; existing shared/symlink destinations are refused. Move older dumps into an appropriately protected location before running the revised job.
- Backups now have a unique suffix so jobs in the same second cannot overwrite each other. Keep the dump and its `.sha256` sidecar together. Failed dump jobs do not publish a backup or prune older files.
- A restore drill requires both files and checks the dump's digest before connecting. Missing checksums now fail; regenerate one for a legacy dump only after independently verifying its authenticity.
- `TARGET_URL` must identify a disposable scratch database; never the live application database. Equal source/target URL strings are rejected, but aliases may still identify the same database, so the operator must verify the destination. Restore uses `--clean`, which drops scratch objects.
- Restore errors and failed/invalid required-table count queries fail the drill. Successful timing includes verification. Compare expected source counts/business balances as well as the script's required-table checks; a count alone is not proof of complete recovery.
- Schedule private backups and copy them off-host to restricted, encrypted storage. Agree RPO/RTO with the owner and record restore timing and reconciliation evidence. Filesystem permissions do not encrypt backups.

## Required operational evidence

Finance/system owner must verify the actual deployment before declaring readiness:

- HTTPS and the public application URL, Secure cookies, OTP and email/mobile verification enabled.
- Strong secrets; database TLS identity, network restrictions, provider disk encryption and applied hardening/session migrations.
- Proxy hop count matches the trusted ingress; ingress overwrites forwarded headers and backend cannot be reached directly. `ALLOWED_ORIGINS` remains an explicit host:port allowlist.
- Email/SMS/payment delivery and callback verification, actual alert routing, scheduled backups/off-host access, and a real production-derived scratch restore with RTO and agreed RPO.
- Browser smoke checks for login, signup, shop, POS, Finance reports and cash shifts.
- Approved retention periods and verified access/correction/deletion procedures per data class. Financial history and append-only audits require documented retention exceptions. Disabling an account is not an erasure request.

No existing customer records are rewritten by these fixes. Do not assign a readiness score until the required evidence is recorded.
