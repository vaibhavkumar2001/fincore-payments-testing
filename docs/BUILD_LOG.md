# Build Log

Short notes on decisions, bugs and lessons while building FinCore.
Format for each entry: what happened, why, and what I would do again or differently.

## Day 2: Accounts and deposits

### 1. A read-modify-write deposit loses money under parallel requests

- **What happened:** I wrote a test that sends ten deposits of 100 at the same time and expects a balance of 1000. To check that the test really detects races, I temporarily replaced the deposit with "read the balance, wait, write balance + amount". The test failed with `Expected: 1000, Received: 100`.
- **Why:** Each request read the same old balance, so each one overwrote the others' updates (a lost update).
- **Fix:** The deposit is one atomic statement: `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`. The database applies the addition, so parallel requests cannot overwrite each other.
- **Lesson:** Never compute a new balance in application code from a value you read earlier. Use an atomic update or a row lock.

### 2. Clients must not be able to set server-owned fields

- **What happened:** `POST /accounts` could have silently accepted `balance_minor` or `id` from the client (mass assignment).
- **Fix:** The Zod schemas use `strict()`, so unknown fields are rejected with `400`. Tests cover a client-supplied balance and a client-supplied id.
- **Lesson:** Rejecting unknown fields is safer than ignoring them, because it makes misuse visible.

### 3. Assert on the database, not only on the API response

- **What happened:** Tests check the database after each call: the row exists after a create, the balance is exact after a deposit, and no row exists after a rejected request.
- **Detail:** `BIGINT` is read as text (`balance_minor::text`) so large values never lose precision in assertions.
- **Lesson:** An API can return the right response while storing the wrong data. The database is the source of truth.

### 4. Concurrency tests assert outcomes, not timing

- **What happened:** The parallel deposit test does not sleep or depend on speed. It sends ten requests with `Promise.all` and asserts that all ten returned `201` and the final balance is exactly 1000.
- **Lesson:** Tests that depend on timing are flaky. Tests that assert on counts and final state are deterministic.

### Decisions made today

- Money is stored as integer minor units (`BIGINT`), never as floats.
- A single deposit is capped at 100,000,000 minor units, and the boundary values (the cap and the cap + 1) are tested.
- Every error uses the same shape: `{ "error": { "code", "message", "details" } }`.
- Each test creates its own account, so tests are independent and safe to run in parallel.