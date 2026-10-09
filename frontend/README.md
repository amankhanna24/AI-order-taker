# Vendor Verification — Frontend

React 19 + Vite + TypeScript (React Router, Axios). See the [root README](../README.md) for the full system overview.

## Setup

```bash
cp .env.example .env   # VITE_API_URL=http://localhost:8000/api/v1
npm install
npm run dev            # http://localhost:5173
```

The backend must be running and its `FRONTEND_URL` must match this origin.

## Scripts

`npm run dev`, `npm run build` (typecheck + bundle to `dist/`), `npm run typecheck`, `npm run lint`, `npm run preview`.

## Pages

| Route | Purpose |
|---|---|
| `/` | vendor list with status filters, search and pagination |
| `/vendors/new` | create a vendor |
| `/vendors/:id` | tabs: details, documents & AI data, comparison & verification, tasks, history |
| `/vendors/:id/review` | read-only reviewer summary with approve / reject |

## Layout

```
src/
  api/          typed Axios wrappers per resource
  components/   VendorForm, documents, Comparison, Workflow, tasks, VersionHistory, common
  hooks/        useVendor (loading/error/reload), useAction (busy + toast on error)
  pages/        route-level screens
  types/        DTOs mirroring the API
```

Buttons that call the API are disabled while in flight, and every request failure is surfaced as a toast or inline error.
