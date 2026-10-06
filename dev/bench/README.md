# SQLite benchmark (local development only)

`npm run bench:sqlite` builds the NFR-05 graph (10,000 items, 1,000 categories, 100,000 edges, deterministic from a seed, with a skewed number of links per category and one category of 5,000 items) through the real `write`, in batches, on a real SQLite file in a temporary folder (deleted afterwards), and times the library's own operations. The memory adapter is run too, only as a reference. Never published; the gate runs only a tiny `smoke` size to check the plumbing.

```
npm run bench:sqlite                          # full size, sqlite and memory, 30 samples each
npm run bench:sqlite -- --adapters sqlite     # skip the reference
npm run bench:sqlite -- --size smoke --samples 5 --no-save
```

Measured (p50, p95, max in milliseconds): the items of one category (a page of 50), the categories of one item, `describeGraph`, the first page and page 100 of the 5,000-item category (the cost of reaching a cursor), one single-operation write and one 1,000-operation write. NFR-05's target is a single-category lookup under 20 ms at p95 ("OVER TARGET" is printed if not). The three-clause set query is measured after M4b. Results are saved as JSON in `bench-results/` (git-ignored).

Numbers depend on the machine; compare runs on the same one. Anything over target belongs in the PLAN Backlog with its number.
