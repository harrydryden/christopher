# Christopher

A single-user tool that watches the careers pages of companies you list, once a day, and keeps a table of keyword-matched roles: new, active, closed, how long each has been live, and your apply/skip decision with a reason. Your reasons train a preference model that ranks future roles and proposes filter changes. It also recommends similar companies to track.

- **Specification:** [docs/SPEC.md](docs/SPEC.md)
- **Status:** specification under review; no code yet.
- **Planned hosting:** Next.js UI on Vercel; scraping and AI worker plus Postgres on Render.
