---
"@runfusion/fusion": patch
---

summary: On Windows, the fallback master key file is now readable only by your account, even for elevated admin users.
category: security
dev: `MasterKeyManager` runs `icacls <staging> /reset` before `/inheritance:r /grant:r <user>:F`, dropping explicit SYSTEM/Administrators ACEs an elevated token stamps on new files.
