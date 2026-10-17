# LeakFinder

> Your Stripe says 240 customers are paying. Your database says 252 have Pro. LeakFinder writes the queries for your schema, runs them in a sealed CreateOS sandbox, and shows you the 12 and the dollars. The model never reads a customer row.

Built in one afternoon for the CreateOS × Stripe Projects hackathon (2026-10-17). Status: building. This README lists only what runs.

## What it does

1. `stripe projects` provisions the stack from the terminal: a CreateOS account and a Neon Postgres, credentials written to `.env`. No dashboard opened.
2. The agent opens one CreateOS micro-VM whose outbound network is limited to `api.stripe.com` and your database host. Anything else is dropped outside the VM.
3. It writes Python for *your* schema: discovers the tables, reads every Stripe subscription, reconciles them, and fixes its own errors when a query fails.
4. Findings go to a file inside the VM. The model only ever sees code, schema, counts and error text; emails are redacted before they can reach it. The transcript of everything the model saw is saved so you can grep it.
5. The agent then writes a fix script. It dry-runs in a fork of the sealed VM; the original is untouched until you apply.

## Run it

```bash
pnpm install
cp .env.example .env           # fill in names from `stripe projects env`, plus ANTHROPIC_API_KEY
pnpm doctor                    # sandbox boots, egress sealed, Stripe and Postgres reachable from inside
pnpm seed                      # a demo SaaS with planted drift (see src/seed.ts for exactly what is planted)
pnpm audit                     # the agent writes and runs the reconciliation
pnpm apply                     # dry run in a fork; add --yes to repair
```

## Layout

- `src/sandbox.ts` the sealed room: create, seal, run, fork, destroy
- `src/agent.ts` the loop: model writes Python, VM runs it, guarded output goes back
- `src/llm.ts` the guard and the transcript
- `src/seed.ts` the demo SaaS and its planted drift; `seed/expected.json` is the answer key
- `src/report.ts` the report rendered on your machine from `findings.json`

## Built with AI assistance

Code in this repository is written with Claude Code during the event. Decisions and testing are the author's.
