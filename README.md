# RemoteOps — multi-org permission console

Submission for the Rhinostream hiring task. The application lives in `starter/`.

## Run it from a clean checkout

```sh
cd starter
npm install
npm run db:reset     # schema + reference data + demo fixture + personalised org
npm run dev          # http://localhost:8080
```

## Tests

```sh
cd starter
node scripts/check-jwt.js
node scripts/check-permissions.js
node scripts/check-personalisation.js
node scripts/check-api.js
npm run build && npx playwright test     # needs: npx playwright install chromium
```

## Write-up

- `BUILD-LOG.md` — the log, appended as the work happened
- `DECISIONS.md` — one section per decision, with the rejected alternative
- Task documents: `BRIEF.md`, `PERMISSIONS.md`, `AUTH-DATA-MODEL.md`, `UI-INVENTORY.md`, `WORKFLOW.md`,
  `starter/DISCOVERY-BRIEF.md`
