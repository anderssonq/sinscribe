---
"sinscribe": patch
---

Support kiro-cli 2.28 when Kiro explores the repository. 2.28 prints only the model's text on stdout and moves tool traffic to stderr, so the session context and spec plan failed with "explored but returned no answer". The answer now starts after the last completed tool call, and reads are taken from the stderr tool lines; kiro-cli 2.3.0 keeps working. When no answer is found, the error now quotes Kiro's last output. The read-only confinement was re-verified on 2.28: reads outside the repository and on denied paths are refused.
