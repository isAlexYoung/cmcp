# Windows command memory restriction removal

Based on the published Windows CMCP v4.24.1 source (`d53baaec49121eff8f1b5a3f627831c802bfe89a`).

The Windows command tools no longer advertise or enforce `memory_limit_mb`. Older conversations may still send that retired field; it is accepted and ignored. The C# command owner no longer sets a job/process commit memory limit, refuses startup based on remaining commit memory, or terminates the command based on remaining system commit memory. CMCP also stops injecting a 1024 MiB V8 old-space limit into child `NODE_OPTIONS`. Caller-supplied environment settings remain intact.

Job ownership, suspended creation before assignment, command timeout, process count, explicit stop and owner-exit cleanup remain in place. This change removes CMCP memory restrictions, not Windows/application limits. A process already assigned to an old guard retains that old job's settings until the user restarts that process.

Validation on Windows: all 219 JavaScript tests passed, including native job inspection confirming that process/job memory flags are unset, a successful 256 MiB native commit with an obsolete 128 MiB parameter, acceptance of the obsolete 16384 MiB parameter on all three command tools, preserved `NODE_OPTIONS`, quoting/pipes/exit codes, explicit stop, and owner-exit cleanup. The tests do not allocate 8 or 16 GiB or start MATLAB.

Local installation application must back up the three modified runtime files and its existing distribution manifest, update only their inventory hashes, and verify the resulting installation tree. It must not stop an existing MATLAB/Node workload or restart the CMCP backend without checking its active work.

Applied locally on 2026-11-23 to `F:/CMCP` without changing its version (4.24.1). Backup: `F:/CMCP/user/hotfix-backups/20261123-083159-unlimited-memory`. The distribution inventory was verified before and after application; only the three changed application hashes were updated. No MATLAB or managed command guard was running before the official manager backend reload. The reloaded backend's authenticated loopback MCP endpoint confirmed the new schemas, acceptance of an obsolete 16384 MiB argument, a successful Windows Node command, no injected `NODE_OPTIONS`, and a 4288 MiB Node-native heap limit. Local loopback evidence: `E:/WSL/Logs/cmcp-unlimited-memory-live-evidence.json`. No public release was created.
