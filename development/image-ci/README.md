# Image CI execution

The previous release-PR image job spent about seven minutes waiting on the global
`edge` concurrency group, followed by an eight-minute job. It repeated caller
unit checks, switched between isolated builders during Compose validation,
repeated platform builds for export, and built ARM64 through QEMU.

Architecture builds now run on native AMD64 and ARM64 runners. Each application
and updater image has a separate architecture-scoped Actions cache. Container
smoke checks run on both architectures. Both isolated Compose variants run in
parallel on AMD64 with the same builder/cache as the loaded test images. The
caller can mark an exact revision already validated; standalone/release callers
still run typechecking and unit tests. The source ref resolves once to keep both
architectures and publication on the same immutable commit.

The required `image / build` job aggregates every architecture/test result and,
when publishing, assembles both image manifests from the tested digest sets.
Only tag publication is serialized. Older builds retain their immutable revision
tag but cannot move `edge` away from current main. Release-tag selection still
uses the existing stable-release validation. Registry exports reuse local tested
build graphs and do not repeat compilation or cache uploads.

Local verification covered both real Compose variants sequentially and in
parallel, native ARM64 startup/persistence and updater binaries/imports, and real
Docker manifest composition in dry-run mode. The parallel Compose rehearsal
completed in 98 seconds locally; this is not a hosted-run speed measurement.
Manifest tests reject incomplete/malformed artifacts and foreign tags before any
registry operation. Workflow validation uses actionlint. Hosted CI must verify
native AMD64/ARM64 execution; actual release publishing happens after approval.
