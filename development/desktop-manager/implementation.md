# Managed local installations

The native host uses a private pipe to an updater supervisor; the server's Node IPC channel grants only bootstrap, status, pairing, aggregate attention and fixed update actions. It does not install HTTP administration capabilities. The updater owns release preparation, rehearsals, snapshots, cutover and recovery.

Compose uses separate app and trusted controller containers. Only the controller has the Docker socket. A persistent override pins the selected image; the management wrapper includes it for all stack operations. Transfer helpers mount the updater volume directly rather than assuming host paths match container paths.

Prepared macOS runtime assets contain a Node executable, production dependencies, built web assets, server, plugins, updater, licenses and build identity. Both native bootstrap and updater validate release identity and archive safety before activation. Release artifacts must be published before shipping a native release that depends on them.
