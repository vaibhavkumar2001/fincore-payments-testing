## Day 4: Capture, void and refunds

### 1. Idempotency was moved into a shared helper, and the tests protected the refactor

- **What happened:** Refund also needs idempotency, so I extracted the claim-key, do-work, store-response logic from the payment creation route into `runIdempotent`.
- **Result:** All 72 existing tests passed without changes after the refactor.
- **Lesson:** A strong test suite is what makes refactoring safe.

### 2. Refunds need an idempotency key, capture and void do not

- **Reasoning:** A second capture or void is stopped by the state machine (`409`). A retried partial refund is not stopped by state, because the payment is still refundable, so it would be applied twice.
- **Lesson:** Idempotency can come from the state machine or from a key. Choose per operation.

### 3. Lock rows in a fixed order to avoid deadlocks

- **Design:** Both accounts are locked with `ORDER BY id FOR UPDATE`.
- **Verification:** I temporarily locked the source first and the destination second, with a small delay. The test with ten parallel captures in opposite directions failed. With the fixed order it passes.
- **Lesson:** Two transactions that lock the same rows in opposite order can deadlock.

### 4. The state machine is tested as a table

- **Design:** Every state is combined with every action (5 states x 3 actions = 15 tests). An illegal transition must return `409` and change nothing (payment row and both balances).
- **Lesson:** Table-driven tests cover a whole state machine without writing 15 different tests by hand.

### 5. Money conservation and the "funds are not held" limit

- **Tests:** The sum of two balances is the same before and after a capture and after refunds.
- **Known limit:** Authorization does not hold funds, so two payments of 800 can both be authorized on a balance of 1000. The second capture fails with `insufficient_funds`, and a test documents this.

### 6. Race bugs are timing dependent

- **What happened:** When I removed the row lock from capture, the capture-vs-void test caught it, but the ten-parallel-captures test did not, because requests finish so fast that the race window is tiny.
- **Next step:** Day 7 bug toggles will add a small delay to make such races reproducible.