# The Order Taker

A chat/voice food-ordering agent. A language model (Gemini) understands the customer; a deterministic **order engine** owns the menu, pricing, availability, validation, state and audit trail. The model can only call validated tools — it never writes order data or computes prices.

- Spec: [requirement.md](requirement.md) · corrections adopted: [docs/requirement-review.md](docs/requirement-review.md)
- `backend/` Express 5 + TypeScript + Prisma 7 + PostgreSQL · `frontend/` React 19 + Vite

## Run

```bash
# 1. database: create "order_taker" in pgAdmin
cd backend
cp .env.example .env      # set DATABASE_URL, ADMIN_API_KEY (24+ chars), optionally GEMINI_API_KEY
npm install
npx prisma migrate deploy
npm run seed              # Green Spoon Kitchen test menu
npm run dev               # http://localhost:8000

cd ../frontend
cp .env.example .env
npm install
npm run dev               # http://localhost:5173  (Order · Menu · Staff)
```

Without `GEMINI_API_KEY` (or when Gemini is unavailable) a deterministic parser handles common phrasings using the same validated tools.

## Tests

`cd backend && npm test` — pricing, tax rounding, alias/ambiguity matching, availability windows.

## Key rules enforced server-side

- Money in integer paise; tax exclusive, half-up per category; totals computed only by `domain/pricing.ts`.
- Ambiguous products/modifiers/references return a clarification, never a guess.
- Required modifier groups must be satisfied; unavailable/closed/time-window items are refused.
- Submission needs: order read back → no changes since → explicit "yes" (or the Confirm button with the matching order version). Duplicate confirms are idempotent.
- Customers authenticate with an unguessable per-conversation token (cross-user access returns 404); staff endpoints need `x-admin-key`.
- Every order mutation writes an `OrderEvent`; escalations store the order and recent messages.

## Known limits

Combo components can't take modifiers; submission only marks the order sent (no POS/payment integration); the per-conversation lock is in-process (single instance).
