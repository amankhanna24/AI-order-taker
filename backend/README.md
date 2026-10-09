# Vendor Verification — Backend

Express 5 + TypeScript API backed by PostgreSQL (Prisma 7). Full overview, environment variables and endpoint list are in the [root README](../README.md); design notes are in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Setup

```bash
cp .env.example .env        # set DATABASE_URL and API keys
npm install
npx prisma migrate deploy   # apply migrations
npm run seed                # optional sample data
npm run dev                 # http://localhost:8000, health at /health
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | watch mode (tsx) |
| `npm run build` / `start` | generate Prisma client, compile, run `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (node:test) |
| `npm run prisma:migrate` | create a new migration in development |
| `npm run prisma:studio` | browse the database |

## Layout

```
src/
  config/       env validation, constants, Prisma client
  routes/       thin routers, mounted under /api/v1
  controllers/  request → service → response
  services/     business logic (vendor, document, ai, company, email, workflow, task)
  validators/   Zod schemas for params, query and body
  middleware/   error handling, upload, validation, rate limiting
  utils/        errors, logger, response helpers, normalisation
prisma/         schema, migrations, seed
```

## Quick check

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/api/v1/vendors -H "Content-Type: application/json" \
  -d '{"companyName":"Acme Ltd","contactPerson":"Jane Roe","email":"jane@acme.test","phone":"9876543210","address":"1 Main Street, Pune"}'
```

## Troubleshooting

- **Cannot connect to database** — check `DATABASE_URL` and that PostgreSQL is running and the database exists.
- **`@prisma/client` missing exports** — run `npx prisma generate`.
- **CORS errors** — `FRONTEND_URL` must match the frontend origin exactly.
- **Extraction / verification / email errors** — the matching API key is unset or invalid; the API returns a descriptive error rather than failing silently.
