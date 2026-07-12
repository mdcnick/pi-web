---
"@jmfederico/pi-web": patch
---

Store session archive metadata and archived session files under `PI_WEB_DATA_DIR` when configured.

Previously, session archives always used `~/.pi-web`, even when `PI_WEB_DATA_DIR` selected another managed-state root. Existing archives created with a custom `PI_WEB_DATA_DIR` remain in `~/.pi-web` and are not migrated automatically. Before upgrading, stop the session daemon and back up both locations before reconciling them manually. Because the archive index stores absolute `archivePath` values, update those values when moving archived files.
