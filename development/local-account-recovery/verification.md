# Local account recovery verification

## Boundary and behavior

Recovery is disabled by default. Account actions require runtime mode, explicit local recovery opt-in, and a connected private IPC parent on every request. No HTTP minting route or extra updater-token privilege is added. The trusted local manager authenticates the installation owner before each recovery request. This trusts that owner and does not defend against a compromised owner account or manager.

Recovery links expire after ten minutes, replace prior invitations, and are stored only as hashes. Eligibility is checked inside issuance and redemption transactions. Recovery excludes disabled and peer-shadow accounts, cannot change names or roles, and revokes sessions on completion. Local request/completion events contain no link or token. Initial setup alone supports username selection; legacy invitations preserve their semantics.

## Checks performed

- Full core suite: 259 passed, zero failed.
- Latest focused account and real-server integration suites: six passed.
- Core type checks and browser build passed.
- Real supervisor rehearsal passed capability negotiation, setup refresh, username selection, listing, recovery, session revocation, isolated errors and clean Quit.
- Migration rehearsal against baseline `87a475c1288ba6198c4194c55f65e7b92010f1c7` preserved the prior account, password, session, invitation and encrypted data; legacy invites cannot rename users.
- Diff whitespace and privacy review: generic synthetic fixtures, no integration-specific material.

Executable rehearsals are in `scripts/rehearse-account-recovery.py` and `scripts/rehearse-local-accounts.ts`.

## Limits and rollout

The supervisor rehearsal used a synthetic development runtime, not published release assets. Browser automation was unavailable; browser behavior was checked through real HTTP integration, type/build checks, and source inspection. OS authentication must be manually exercised by the trusted manager's owner. Publish a supporting core runtime before releasing a manager that advertises these account actions. Older clients remain compatible and older runtimes must report unavailable functionality.
