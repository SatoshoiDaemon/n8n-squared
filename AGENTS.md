# n8n-squared working rules

- Use pnpm and the versions declared in `package.json`.
- Preserve workflow, node, credential, editor, and database contracts from the recorded n8n base.
- Investigate source code, logs, and existing contracts before treating an issue as external.
- Keep operational settings and secrets intact unless a demonstrated requirement calls for a change.
- Build a Node.js runtime artifact for Square Cloud. Docker is not part of the build or deployment path.
- Use a dedicated local data directory for smoke tests. Never test with another instance's data.
- Keep the upstream remote for comparison. The Squared main branch has independent history.
- Run the relevant package checks after each change. Redirect full build output to a log file.
