# Extracted plugin migration fixtures

`extracted-plugins.tgz` freezes the 19 plugin implementations extracted from Switchboard in October 2026. It is an offline regression baseline for existing credentials, settings, documentation, helper exports and peers. Tests unpack it into isolated installed-plugin directories; production never loads this archive.

The live implementations are maintained in the individual `tader/switchboard-plugin-<id>` repositories, listed in the community catalog. Do not develop plugins in this snapshot. Preserve it to exercise migrations without downloading or executing remote code.
