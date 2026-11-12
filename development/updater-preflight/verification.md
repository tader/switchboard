# Updater preflight failures and cancellation

A controller could fail while locating Compose configuration or validating the
managed data mount, before creating its journal or reporting preparation. The
polling loop swallowed that failure, leaving an online controller and a queued
job indefinitely. Cancellation also depended on that failing worker.

The controller now persists preflight failures outside deployment journals,
reports a fixed public error, and retries only acknowledgement after an API
outage. Local diagnostics remain owner-only; subprocess output is withheld.
Standalone and desktop controllers share polling, including safe idle polling
and terminal journal reconciliation. Queued cancellation is immediate on the
server; preparation cancellation is acknowledged before preparation or cutover,
with visible pending feedback. A late preflight failure cannot revive a cancelled
job.

Validation:

- Full suite: 253 tests passed, no skips; server typecheck and web build passed.
- The three subprocess regression scenarios fail against the previous production
  polling entry point and pass against the changed entry point. They cover failed
  Compose validation, queued cancellation without Docker, and acknowledgement
  retry after an API outage. An idle-poll regression covers the missing journal.
- Real disposable Docker Compose daemon rehearsal: missing configuration and a
  mismatched data volume report failed; corrected settings reach journalled
  preparation. A deliberately unavailable target fails before cutover. Queued
  cancellation succeeds with the updater stopped. The application container
  remains unchanged and ready throughout. No target publication is needed.
- The daemon rehearsal runs alongside existing Compose rehearsals in AMD64 CI,
  reusing already built images and performing no additional image build.
- Synthetic Chrome checks: cancellation feedback, disabled repeated cancellation,
  immediate queued cancellation and preflight error; light/dark, 1440/390 pixels,
  keyboard activation and overflow checks passed. Screenshots inspected locally.

The daemon rehearsal tests actual polling and failure acknowledgement. Existing
controller lifecycle rehearsals cover candidate cutover and rollback; this new
rehearsal deliberately performs neither. No live upgrade is part of validation.
