---
"@runfusion/fusion": patch
---

summary: Claude CLI turns get their instructions and report failures; remote, child-process and Windows runtimes stop cleanly.
category: fix
dev: pi-claude-cli writes a per-invocation prompt file passed via `--append-system-prompt-file`, ends failed/aborted turns with pi-ai's `error` event (`stopReason` `error`/`aborted`, `errorMessage`) on both the `-p` and ACP routes, settles pre-aborted requests without spawning, and launches `claude` through core's shell-free seam (staged into the published raw extension by the CLI build). RemoteNodeClient keeps deadline and caller abort attached through body consumption and cancels stalled readers. ChildProcessRuntime tracks one child generation at a time, retires and awaits the old child before restarting or stopping, and the worker exits when its host disconnects. Code nodes import their module by file URL, and the empty-commit hook detects `--amend` under Git for Windows.
