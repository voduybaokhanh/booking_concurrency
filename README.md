# Seat Booking Concurrency (NestJS + Prisma + Redis)

## Why this exists
- **Race condition**: concurrent requests can read AVAILABLE and both write BOOKED, causing double booking.
- **Fix**: combine distributed lock (Redis), DB transaction boundary, and optimistic locking on the seat row. Database remains source of truth.
- **Idempotency**: `Idempotency-Key` guarantees a request is applied once.

## Architecture at a glance

```
flowchart TD
  client[Client] --> api[POST /bookings<br/>Idempotency-Key header]
  api --> idempotency[Check IdempotencyRecord]
  idempotency -->|Cached| returnCached[Return cached response]
  idempotency -->|New/Retry| redlock[Redlock: Acquire lock on quorum]
  redlock -->|Lock acquired| tx[Prisma Transaction<br/>READ COMMITTED]
  tx --> seatCheck[Check seat status+version]
  seatCheck -->|Available| booking[Insert booking<br/>Create IdempotencyRecord]
  booking --> seatUpdate[Update seat version<br/>Optimistic lock]
  seatUpdate -->|Version mismatch| conflict[409 Conflict]
  seatUpdate -->|Success| commit[Commit transaction]
  commit --> unlock[Release Redlock]
  unlock --> updateIdempotency[Update IdempotencyRecord<br/>SUCCESS + cache response]
  updateIdempotency --> returnSuccess[Return 201 Created]
```

**Key layers**:
1. **Idempotency layer**: Prevents duplicate processing, caches responses
2. **Redlock layer**: Distributed mutual exclusion across Redis instances
3. **Transaction layer**: Atomic DB operations
4. **Optimistic lock layer**: Version-based conflict detection

## Data model

### Seat
- `status`: `AVAILABLE | HOLD | BOOKED`
- `version`: Integer for optimistic locking (incremented on each update)
- `holdExpiresAt`: Timestamp for hold TTL
- Index on `(status, holdExpiresAt)` for efficient expiry queries

### Booking
- `status`: `CONFIRMED | CANCELLED | EXPIRED`
- `idempotencyKey`: Unique constraint for idempotency
- `expiresAt`: Optional TTL for booking expiry
- Index on `seatId` and `(status, expiresAt)`

### IdempotencyRecord
- `idempotencyKey`: Primary key
- `state`: `IN_PROGRESS | SUCCESS | FAILED`
- `requestHash`: SHA256 hash of request payload for validation
- `responseData`: Cached JSON response for `SUCCESS` state
- `statusCode`: HTTP status code of cached response
- `expiresAt`: TTL for automatic cleanup

## How we prevent double booking

### 1. Redlock Algorithm (Production-Safe Distributed Locking)

We implement the **Redlock algorithm** to safely coordinate locks across multiple Redis instances, preventing the "lock expiry mid-transaction" problem:

**Problem**: Simple `SET NX PX` locks can expire if:
- Process A acquires lock, then gets paused (GC/crash)
- Lock TTL expires → Process B acquires lock
- Process A resumes and commits → **double booking**

**Solution**: Redlock with:
- **Unique lock tokens**: Each lock acquisition generates a UUID token
- **Quorum-based acquisition**: Lock succeeds only if acquired on majority of Redis instances
- **Token validation on release**: Lua script ensures only the token owner can release
- **Lock extension**: Long-running operations can extend locks before expiry
- **Drift compensation**: Accounts for clock drift between Redis instances

```typescript
// Lock acquisition requires quorum (N/2 + 1) of Redis instances
const lockResult = await redlockService.acquireLock(`seat:${seatId}`, ttlMs);
// Work protected by lock
await redlockService.releaseLock(key, lockResult.token); // Only token owner can release
```

**Trade-off**: Requires multiple Redis instances (minimum 3 for production), but guarantees safety even if one instance fails.

### 2. Database Transaction Boundary

All seat checks and booking creation happen within a **single Prisma transaction** (`READ COMMITTED` isolation level by default). This ensures:
- Atomicity: Either all operations succeed or none
- Consistency: No partial state visible to other transactions
- Isolation: Concurrent transactions see committed data only

**Why not `SERIALIZABLE`?** We use optimistic locking with version checks instead. `SERIALIZABLE` would cause more rollbacks and lower throughput. Our approach:
- Redis lock reduces contention at the application level
- Optimistic version check catches stale updates
- Database remains source of truth

### 3. Optimistic Locking (Version-Based)

Seat updates use `updateMany` with version guard:
```typescript
const updated = await tx.seat.updateMany({
  where: { id: seat.id, version: seat.version },
  data: { status: 'BOOKED', version: { increment: 1 } },
});
if (updated.count === 0) {
  throw new ConflictException('Seat changed during booking');
}
```

**Why optimistic over pessimistic (`SELECT FOR UPDATE`)?**
- **Optimistic**: Assumes low contention, checks version at write time
  - Higher throughput under normal load
  - Lower DB lock contention
  - Requires retry logic (handled by Redis lock + idempotency)
- **Pessimistic**: Locks row during read, prevents concurrent modifications
  - Guarantees no conflicts but blocks other requests
  - Higher DB connection usage
  - Can cause deadlocks in complex scenarios

Our hybrid approach: Redis lock (pessimistic at app level) + optimistic DB version check = best of both worlds.

### 4. Idempotency State Machine

Full state machine prevents duplicate processing and handles timeout scenarios:

**States**:
- `IN_PROGRESS`: Request being processed
- `SUCCESS`: Request completed, response cached
- `FAILED`: Request failed or timed out

**Flow**:
1. Check idempotency record
2. If `SUCCESS`: Return cached response immediately
3. If `IN_PROGRESS` + not expired: Reject (409 Conflict)
4. If `IN_PROGRESS` + expired: Mark as `FAILED`, allow retry
5. If `FAILED`: Reject (409 Conflict)
6. If not found: Create `IN_PROGRESS` record, process request, update to `SUCCESS`/`FAILED`

**Request hash validation**: Ensures same idempotency key with different payload is rejected.

**Response caching**: Successful responses are stored for TTL duration, allowing clients to safely retry.

### 5. Hold TTL and Auto-Release

Seats can be placed on `HOLD` with a TTL (default 2 minutes). Background sweeper:
- Runs every `HOLD_SWEEP_INTERVAL_MS` (default 10s)
- Releases expired holds atomically
- Booking flow checks expiry before rejecting held seats

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

# chaos tests (comprehensive failure scenarios)
npm test -- booking.chaos.spec.ts
```

### Test Coverage

**Basic concurrency** (`booking.concurrency.spec.ts`):
- 20 concurrent booking requests → 1 success, 19 conflicts
- Hold expiry allows booking after TTL

**Chaos tests** (`booking.chaos.spec.ts`):
- Lock expiry mid-transaction handling
- Same idempotency key from multiple concurrent requests
- Redis delay simulation (network latency)
- DB commit delay simulation
- Extreme concurrency (50 parallel requests) → zero duplicates
- Idempotency key reuse with different payload rejection
- Latency measurement under load

These tests validate the system handles:
- Network partitions
- Process pauses (simulated via delays)
- Lock expiry during long operations
- Idempotency edge cases

## Postman
`postman/collection.json` covers normal booking, double-click (idempotent), concurrent booking, hold-expired.

## Env knobs

### Core
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Single Redis instance (fallback)
- `REDIS_URLS`: Comma-separated Redis URLs for Redlock (e.g., `redis://localhost:6379,redis://localhost:6380,redis://localhost:6381`)
- `PORT`: Application port (default 3000)

### Timing
- `HOLD_TTL_MS`: Hold expiration time in ms (default 120000 = 2 minutes)
- `HOLD_SWEEP_INTERVAL_MS`: Background sweeper interval (default 10000 = 10s)
- `LOCK_TTL_MS`: Redis lock TTL in ms (default 5000 = 5s)
- `IDEMPOTENCY_TTL_MS`: Idempotency record TTL (default 300000 = 5 minutes)
- `IDEMPOTENCY_CLEANUP_INTERVAL_MS`: Idempotency cleanup interval (default 60000 = 1 minute)
- `BOOKING_CLEANUP_INTERVAL_MS`: Booking expiry cleanup interval (default 60000 = 1 minute)

### Redlock
- `REDLOCK_DRIFT_FACTOR`: Clock drift compensation factor (default 0.01 = 1%)
- `REDLOCK_RETRY_COUNT`: Lock acquisition retry attempts (default 3)
- `REDLOCK_RETRY_DELAY_MS`: Delay between retries in ms (default 200)

## Project layout (aligned to Developer Guide)
- `src/seat` — seat use cases + hold sweeper
- `src/booking` — booking flow with idempotency + locks
- `src/common` — Prisma client, Redis lock, transactions, env helpers
- `prisma/` — schema + migrations
- `scripts/` — CI enforcement (`ban-debug.sh`, `ban-try.sh`, `audit.sh`)
- `postman/` — API collection

## Trade-offs: Redis lock vs DB-only

### Redis Lock (Redlock) - Current Approach
**Pros**:
- Reduces DB connection pool pressure
- Faster conflict detection (no DB round-trip)
- Can handle lock expiry gracefully with token validation
- Works across multiple app instances (stateless)

**Cons**:
- Requires Redis availability (SPOF if single instance)
- Network latency for lock acquisition
- Redlock requires multiple Redis instances for production safety
- Lock expiry mid-transaction still possible (mitigated by lock extension)

### DB-Only (SELECT FOR UPDATE)
**Pros**:
- Single source of truth (no external dependency)
- Strong consistency guarantees
- No network calls for locking

**Cons**:
- Higher DB connection usage (locks held during transaction)
- Longer blocking times (transaction duration)
- Potential deadlocks in complex scenarios
- Still needs optimistic version check for stale updates

**Our choice**: Redlock + optimistic DB version check provides:
- Fast conflict detection (Redis)
- Strong consistency (DB transaction)
- Graceful handling of lock expiry (token validation + extension)
- High throughput (optimistic locking)

## Operational notes
- No debug prints or local try/catch in business logic; use global error handling.
- Idempotency key reuse with different payload is rejected (409).
- Expired holds are reclaimed automatically; booking path also respects expiry.

## What This System Does NOT Solve

**Explicit scope boundaries**:

1. **Payment concurrency**: This system only handles seat reservation. Payment processing, refunds, and payment race conditions are out of scope.

2. **Long-running bookings**: Bookings are assumed to complete within lock TTL (default 5s). For operations taking minutes/hours, use saga pattern or two-phase commit.

3. **Distributed transactions**: We don't coordinate across multiple databases or external services. Each booking is atomic within a single DB transaction.

4. **Cross-seat operations**: Booking multiple seats atomically (all-or-nothing) is not supported. Each seat is locked independently.

5. **User session management**: No authentication/authorization. `userId` is passed as-is.

6. **Booking cancellation workflow**: Cancellation exists in schema but no business logic implemented.

7. **Redis failover**: Redlock handles single instance failure, but full Redis cluster failover requires additional configuration.

**What it DOES solve**:
- ✅ Seat-level contention in short critical sections (< 5s)
- ✅ Concurrent booking requests for same seat
- ✅ Idempotent request handling
- ✅ Hold expiry and auto-release
- ✅ Zero duplicate bookings under extreme concurrency

## Future improvements
- Add per-user hold ownership (restrict hold-to-booking conversion to holder)
- Add metrics on lock contention, expired-hold reclaim counts, and idempotency hit rates
- Implement booking cancellation workflow with proper state transitions
- Add Redis Sentinel/Cluster support for high availability
- Consider saga pattern for multi-seat bookings
