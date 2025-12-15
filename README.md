# Seat Booking Concurrency (NestJS + Prisma + Redis)

## Why this exists
- **Race condition**: concurrent requests can read AVAILABLE and both write BOOKED, causing double booking.
- **Fix**: combine distributed lock (Redis), DB transaction boundary, and optimistic locking on the seat row. Database remains source of truth.
- **Idempotency**: `Idempotency-Key` guarantees a request is applied once.

## Architecture at a glance
```
flowchart TD
  client[Client] --> api[POST /bookings]
  api --> lock[Redis lock seat:{id}]
  lock --> tx[Prisma transaction]
  tx --> seatCheck[Check seat status+version]
  seatCheck --> booking[Insert booking (idempotent)]
  booking --> seatUpdate[Update seat status+version]
  seatUpdate --> commit[Commit]
  commit --> unlock[Release lock]
```

## Data model
- `Seat`: `status` (`AVAILABLE|HOLD|BOOKED`), `version` (optimistic lock), `holdExpiresAt`, timestamps, index on `(status, holdExpiresAt)`.
- `Booking`: `idempotencyKey` unique, `status` (`CONFIRMED|CANCELLED`), FK to seat, index on `seatId`.

## How we prevent double booking
1) **Redis distributed lock**: `SET seat:{id} token NX PX <ttl>` blocks parallel book/hold on same seat. Lua unlock ensures token ownership.
2) **DB transaction**: everything in one Prisma `$transaction`.
3) **Optimistic locking**: seat updates use `updateMany` with `version` guard; if 0 rows affected, we return 409 conflict.
4) **Idempotency**: `Idempotency-Key` header enforced; existing booking with same key returns prior result, mismatched payload conflicts.
5) **Hold TTL**: holds expire automatically; background sweeper releases expired holds before booking attempts proceed.

## Endpoints
- `POST /seats/seed` `{ count }` — seed seats.
- `GET /seats/:id` — seat status.
- `POST /seats/:id/hold` — place a hold (TTL).
- `POST /bookings` — body `{ seatId, userId }`, header `Idempotency-Key`.
- `GET /bookings/:id` — booking detail.

## Running locally (Docker)
```bash
cp env.example .env
docker-compose up --build
```
Services: Nest app on `:3000`, Postgres on `:5432`, Redis on `:6379`.

## Running locally (node)
```bash
cp env.example .env
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

## Testing
```bash
# integration + unit
npm test
```
- Deterministic concurrency test: `test/integration/booking.concurrency.spec.ts` fires 20 parallel booking requests; expects 1 success, 19 conflicts.
- Hold expiry test validates expired holds are auto-released then bookable.

## Postman
`postman/collection.json` covers normal booking, double-click (idempotent), concurrent booking, hold-expired.

## Env knobs
- `HOLD_TTL_MS` (default 120000)
- `HOLD_SWEEP_INTERVAL_MS` (default 10000)
- `LOCK_TTL_MS` (default 3000)
- `DATABASE_URL`, `REDIS_URL`, `PORT`

## Project layout (aligned to Developer Guide)
- `src/seat` — seat use cases + hold sweeper
- `src/booking` — booking flow with idempotency + locks
- `src/common` — Prisma client, Redis lock, transactions, env helpers
- `prisma/` — schema + migrations
- `scripts/` — CI enforcement (`ban-debug.sh`, `ban-try.sh`, `audit.sh`)
- `postman/` — API collection

## Trade-offs: Redis lock vs DB-only
- Redis lock reduces DB contention and simplifies conflict signaling, but requires Redis availability.
- DB-only approach (SELECT FOR UPDATE) would still need optimistic version checks and could block longer; we keep DB as source of truth but offload mutual exclusion to Redis with short TTL.

## Operational notes
- No debug prints or local try/catch in business logic; use global error handling.
- Idempotency key reuse with different payload is rejected (409).
- Expired holds are reclaimed automatically; booking path also respects expiry.

## Future improvements
- Add per-user hold ownership.
- Add metrics on lock contention and expired-hold reclaim counts.
