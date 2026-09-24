# The Men's Essential — Retail ERP + POS

Two parts in this repo:

- **`frontend/`** — the interactive demo (`index.html`). A single self-contained
  HTML/JS/CSS file: dashboard, POS billing, inventory, purchases, customers,
  reports, GST compliance. Runs entirely in the browser with in-memory sample
  data — no server needed, but data resets on refresh. Just open `index.html`
  in any browser.

- **`backend/`** — a real API + PostgreSQL database implementing the same core
  domain (products/variants, ledger-based stock, purchases with landed cost,
  GST-aware POS billing, customers, reports). This is the persistence layer
  the frontend demo doesn't have yet. See `backend/README.md` for setup.

## Status

The frontend is a finished, tested demo of the screens and workflow. The
backend is a tested, working foundation (schema + API), covering the core
transactional flows. They are **not wired together yet** — the frontend still
uses its own in-memory data rather than calling this API. Connecting the two
(swapping the frontend's data functions for `fetch()` calls to the backend,
and its login screen for `POST /auth/login`) is the next piece of work.
