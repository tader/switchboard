# Activity output implementation and verification

The shared Activity detail adds an on-demand selected-field JSON preview and an admin-only retention route. The default is four hours; request retention is independent. Read and status endpoints enforce full access, ownership, ready metadata, generation and deadline. Status returns no payload. A client renews every five seconds and anchors a maximum 15-second display grant to monotonic request-send time.

Encrypted files and temporary files live in an isolated private root. Audit metadata, settings and transactional unlink queues remain in SQLite; database payloads never contain preview JSON or ciphertext. Each encrypted envelope binds owner, audit ID, capture ID and generation. In-flight capture also binds a per-request nonce and policy revision. Updater restore/rollback durably retires the generation before replacing data; interruption tombstones are reconciled before opening storage.

## Verification performed

- Server TypeScript check and production web build.
- Full core suite: 273 tests pass, including proxy, HTTP MCP, native MCP, peers, WebSocket, security boundaries, gated startup and controller-death recovery.
- New synthetic output tests cover exact four-hour and one-hour deadlines before sweeping, shortening/increasing, zero/re-enable, independent unlimited request retention, encryption, restart, parent/user deletion queues, legacy/missing/unavailable states, scope/owner/session/token authorization, selected/unknown/nested fields, credential echoes, UTF-8 lengths, exact 16 KiB input/output boundaries, oversize, malformed/interrupted/cancelled streams, upstream errors/redirects, final 401 retry, all HTTP response consumers, policy fencing and numeric audit-ID reuse.
- Migrated an archived previous core revision (0dbe759) against synthetic data: legacy audit rows survive without preview backfill.
- Actual managed Compose containers: exact additional writable named volume, private encrypted capture, scan of snapshot files including database sidecars for exact ciphertext and payload, backup preserving the live file, generation retirement, restore and refusal to revive restored metadata. Backup/rehearsal helpers retain their original data/state-only mounts.
- Checkout snapshot/rollback tests verify exclusion and retirement before restart. State-injection tests cover interrupted retirement and old metadata/ciphertext restoration across generation and numeric-ID reuse.
- Headless system Chrome: real shared UI with synthetic data; reveal is on demand, Enter/Space, Hide, Escape and focus return; legacy/omitted/expired states; failed load/Retry; close during a held reveal and late-response disposal; failed/hung status checks; page-hide clearing; two clients shorten and disable storage; Cancel-first confirmation and form validation. Inspected light desktop, dark 320 CSS px and 200% equivalent viewport/DPR captures. Measured new heading/helper text contrast against rendered dialog backgrounds.

Reproducible helpers: scripts/rehearse-activity-output-ui.mjs (caller supplies Playwright and Chrome) and scripts/rehearse-activity-output-compose.py (requires local QA app/updater images). They create disposable synthetic instances and clean up their owned services.

## Dependencies and limits

Use a matching core, checkout launcher or Compose updater, and a plugin with an audited optional projection declaration. Reinstall checkout launchers so the shared storage module is present. Managed Compose requires the updated bundle and compose.previewVolume naming the dedicated volume; capture is enabled only when the compatible controller starts the app. Old settings/bundles continue to omit capture until configured.

Native runtime capture is explicitly disabled: native installer backup/restore paths have not integrated generation retirement. No macOS or Windows installer source was changed, and native installer snapshots/embedded-host behavior were not runtime-verified. The shared UI was verified in macOS Chrome. Manual, unmanaged filesystem restores are outside the managed restore contract; keep capture disabled unless the writer is stopped and its isolated generation is retired before replacement.

The interrupted-restore checks use durable-state injection plus the existing real controller-death rehearsal, rather than power-loss testing at every filesystem instruction. Platform power-loss behavior, Windows ACL provisioning and non-Chrome browsers remain unverified. No live upstream credentials or real user payloads were used.
