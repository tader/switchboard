# Managed WebSocket implementation

Scope: core plugin operations, API/MCP access, buffered in-memory subscriptions,
peer forwarding, console and saved commands. No raw sockets, automatic recovery,
Home Assistant plugin changes, or deployment.

- [x] Plugin contract, schema validation, authenticated bounded transport/pooling
- [x] Commands, subscriptions, access invalidation and audit
- [x] HTTP/MCP interfaces and saved commands/migration
- [x] Peer capabilities, forwarding and remote subscription cleanup
- [x] Console commands/subscriptions and activity details
- [x] Plugin/API/MCP/peer documentation and OpenAPI
- [x] Real upstream tests, migration rehearsal, full checks and visual inspection

Defaults: 30s open/auth, 60s commands; 256 KiB arguments/events; 1 MiB frames/results;
512 KiB event pages; 5-minute leases and terminal retention; 8/16/64 principal/user/
instance quotas; no command replay following an uncertain outcome.

## Verification

- Full test suite: 85 passed, 0 failed.
- Server typecheck and production web build passed; diff whitespace check passed.
- Real upstream fixture covers header/message authentication, refresh, reuse,
  schemas, scope and principal isolation, cancellation, cursors/overflow, leases,
  quotas, logout/revocation, saved commands, and modern/legacy MCP.
- Three throwaway instances verified one/two-hop execution, buffered subscriptions,
  explicit stop, token revocation cleanup, unsharing, and link interruption.
- Previous HEAD upgrade rehearsal preserved HTTP/MCP saved calls and audit history;
  new WebSocket commands persisted after reopening; foreign-key check passed.
- Chrome verified command/results, saving commands, live events/stop, and activity
  in light/dark/mobile layouts without page errors or horizontal overflow.
- Home Assistant plugin unchanged. Deployment was not requested or performed.
