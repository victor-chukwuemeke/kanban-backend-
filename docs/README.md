# KanbanFlow — audit supporting material

Overflow for the training exercise write-up: the queries and the diagrams, kept out of
the document itself.

**Subject:** the Board module, with `PATCH /api/boards/:boardId/tasks/:taskId/status` —
the card move — as its hot path.

| | |
|---|---|
| **[QUERIES.md](QUERIES.md)** | Every query the module runs, with its plan before and after. Includes the index that looked correct and did nothing, the `$or` sorting result, the N+1 in signup, and the pagination measurements. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | System map (question 1.5) and the write-collision sequence diagram (question 5.2). |
| **[adr/0001-user-cache-invalidation.md](adr/0001-user-cache-invalidation.md)** | Architecture Decision Record — why the user cache uses TTL expiry rather than delete-on-write. |
| **[../audit/](../audit/)** | Raw measurement output. Every number quoted in the write-up traces back to a file here. |

## Reproducing any of it

All measurements come from scripts in [`../scripts/`](../scripts/), against a database
seeded to 5,015 boards. The real database has 11, which is far too few for a query plan
to show anything.

```bash
node scripts/seed.js --email <you> --boards 5000   # create volume
node scripts/explain.js --email <you>              # query plans
node scripts/toggle-indexes.js --drop|--create     # flip between before/after
node scripts/concurrency-test.js                   # reproduce the write collision
node scripts/pagination.js --email <you>           # OFFSET vs keyset
node scripts/indexes.js                            # index usage via $indexStats
node scripts/seed.js --email <you> --clean         # remove seeded data
```

## Two caveats that apply throughout

Document counts come from the **seeded** database, not production.

Timings were measured from a development machine against MongoDB Atlas over the internet,
where one round trip is roughly 300 ms. In production the Render instance and the Atlas
cluster may share a region, where that would be single-digit milliseconds. The **shape**
of each finding is real; the absolute millisecond values are inflated by where they were
taken.
