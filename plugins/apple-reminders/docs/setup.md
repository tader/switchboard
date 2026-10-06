---
title: Apple Reminders
services: [apple-reminders]
---

# Apple Reminders

The Apple Reminders plugin exposes the reminders belonging to the macOS user running Switchboard. It uses Apple's EventKit framework and is advertised only when Switchboard runs directly on macOS.

The first connection asks macOS for full Reminders access. If the prompt cannot appear, or access was previously denied, open **System Settings → Privacy & Security → Reminders** and allow **Switchboard Apple Reminders**.

> [!IMPORTANT]
> Run Switchboard in the logged-in user's session, for example from Terminal or a per-user LaunchAgent. A system daemon does not share the user's graphical session and may be unable to show the privacy prompt or access that user's reminders.

The Mac needs the Xcode Command Line Tools (`xcode-select --install`) once so the plugin can compile its small EventKit helper. The resulting helper is kept in Switchboard's data directory and reused.

Available operations list reminder lists, list or fetch reminders, create reminders, update their title, notes, list, due date, completion state or priority, and delete reminders. Due dates use ISO 8601 date-times; set `notes` or `dueDate` to `null` to clear it. EventKit priorities are `0` (none), `1` (high), `5` (medium), and `9` (low).
