# Squared working rules

## Product runtime

- The product runtime is the JavaScript application in `src/`. Run it with Node.js 24 and `npm start`.
- `packages/` is retained source material from the historical n8n base. It is not an active workspace, deploy dependency, startup path, or product contract. Do not add imports from it to `src/` by default.
- Keep the runtime dependency list small. Update `package-lock.json` with npm when `package.json` changes.
- Durable workflows, executions, credentials, and admin sessions use SQLite in `squared-data/` on Square Cloud's persistent application disk by default. PostgreSQL is an optional backend through `SQUARED_DATABASE_URL` or `DATABASE_URL`.
- Never use the operating-system temporary directory for product data. Keep `squared-data/` out of the ZIP; Square Cloud preserves app disk files between deploys and commits replace only ZIP contents.
- The encryption key is generated once in protected persistent storage. `SQUARED_ENCRYPTION_KEY` is an optional stable override. Do not log tokens, keys, credential values, or database URLs.
- First-admin setup uses a one-time code in `squared-data/bootstrap-code`, readable by the deployment owner through the platform's File Manager. Do not log or expose this code.
- Treat workflow values and webhook input as untrusted. Do not add arbitrary code execution unless it runs in a properly isolated process with explicit resource limits.
- Keep concurrency and request sizes bounded. Do not claim a 512–1024 MB memory target without measurements.
- Version Squared independently from the historical n8n source recorded in `UPSTREAM.md`.

## Build, checks, and Square Cloud

- The runtime needs no compile step. `npm run build` performs a syntax check; `npm run package:squarecloud` creates the ZIP directly.
- The ZIP must contain an ordinary Node.js app with `src/main.js`, an npm lockfile, and the minimum production dependencies. It must not contain the inherited workspace tree.
- Use `npm test` for the isolated core tests. Do not run the old monorepo build or `build:data` as part of Squared validation.
- `npm run smoke:squarecloud` uses an isolated disposable SQLite directory and removes it afterward. Never point it at another instance's data.
- Keep deployment as a ZIP for Square Cloud. Do not add Docker, Kubernetes, service orchestration, or local-file persistence to the product.

## Git

- Start repository changes on a new task branch after checking Git status and updating from the requested base branch.
- Preserve licensing notices and the historical source reference. Do not link Squared release numbers to n8n release numbers.
- Make focused commits, then push and open a pull request when requested by the task.
