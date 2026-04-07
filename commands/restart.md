---
description: Restart the ClaudeClaw daemon (stop existing + start fresh)
---

Restart the ClaudeClaw daemon by running:

```bash
nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start --replace-existing --web > .claude/claudeclaw/logs/daemon.log 2>&1 & echo $!
```

The `--replace-existing` flag sends SIGTERM to the running daemon, waits up to 4s for graceful shutdown, then starts a fresh daemon.

Wait 2 seconds, then check the log:

```bash
tail -5 .claude/claudeclaw/logs/daemon.log
```

Report the outcome to the user. If the log shows the daemon started successfully, confirm and show the new PID from `.claude/claudeclaw/daemon.pid`.
