# Windows prepared runtimes

Adds Windows x64/ARM64 runtime packaging and private graceful shutdown. Runtime-mode owned Windows processes are stopped through their existing parent-child IPC rather than emulated POSIX termination. An unmanaged process is never stopped using an advisory PID. The existing server drain and lease cleanup run for IPC disconnect too.

Local verification: typecheck and all 259 core tests passed; targeted desktop tests passed after adding Windows manifest and archive-name regressions. Windows prepared-runtime jobs exercise the independent runtime lifecycle on matching x64/ARM64 runners. Native Windows results must pass before this change is ready to merge.

No provider-specific integrations or credentials are used by these checks.
