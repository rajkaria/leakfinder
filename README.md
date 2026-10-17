# LeakFinder

> LeakFinder is an AI agent that finds money leaking between Stripe and your database. It writes its own code and runs it in a sealed CreateOS sandbox.

Built in one day for the CreateOS × Stripe Projects hackathon (2026-10-17 PT). Status: building. Anything marked *(verify live)* has not yet run against real services.

## What it does

A SaaS app records who has Pro in its own database and who pays in Stripe. When a webhook is missed or was never verified, the two stop matching.

The demo app is Vercel's [Next.js SaaS Starter](https://github.com/nextjs/saas-starter), with its database schema exactly as the starter ships it (commit `6e33e58`, `seed/saas-starter.sql`). LeakFinder plants the drift, never the schema. The app says 48 teams have Pro. Stripe has 39 paying subscriptions, and only 36 of them belong to those teams. The gap hides three problems:

| | What drifted | Demo data |
|---|---|---|
| A | Pro access nobody pays for (7 never paid, 5 cancelled in Stripe without the app hearing) | 12 teams, $348 a month |
| B | People paying with no account to log in to | 3 subscriptions |
| C | App rows that say `active` while Stripe says `canceled` | 5 rows |

A second schema, with users, customers, subscriptions and an `entitlements` table (`seed/schema.sql`), carries the same drift, so the agent has to write different code for each.

LeakFinder reads your schema, writes Python that reconciles it with every Stripe subscription, runs that Python in a CreateOS micro-VM, and shows you the people and the dollars. Then it writes a fix, dry-runs it, and applies it in Stripe test mode when you say so.

## Three things to check

1. **The agent writes and fixes its own code, in a sealed room.** The sandbox can reach `api.stripe.com` and your database's addresses on its port. Everything else is dropped on the host, outside the VM, so code inside cannot change the rule. When a query fails, the agent reads the error and rewrites the script.
2. **The model never sees a customer.** It gets code, schema, counts and error text, with email addresses redacted before anything leaves your machine for the model. Every byte it was shown is saved in `runs/<run>/transcript.jsonl`, and the audit greps that file for a planted customer email.
3. **Apply recovers the money, in Stripe test mode.** Unpaid Pro access is revoked, and the accounts that never paid get an invoice to keep it (the ones that cancelled on purpose are never billed). People paying with no account are refunded and cancelled, stale rows are synced. `pnpm verify:starter` then recounts the drift straight from Postgres and Stripe, with no model involved *(verify live: zeros after Apply)*.

## How it works

1. `stripe projects` provisions the stack from the terminal: CreateOS and a Postgres database, with credentials written to `.env` *(verify live)*.
2. LeakFinder opens one CreateOS micro-VM with the outbound allowlist set at create time: `api.stripe.com`, the database's IPv4 addresses on its port, and the VM's DNS resolver. Before any model-written code runs, LeakFinder tests the lock from inside: `example.com` and `pypi.org` get no answer and `api.stripe.com` does. The allowlist is in force from the first packet. If the VM's image lacks the two Python libraries, they arrive as wheels built on your machine, so the VM never talks to PyPI.
3. The model writes Python for your schema, the VM runs it, and only the exit code, counts and error text go back, with email addresses removed. A failing script is rewritten, up to eight turns. A working script is saved for that schema, so the next run on it needs no model turns.
4. Findings are written to a file inside the VM. The report is built from that file.
5. The model writes a fix script. It runs first with `APPLY` off, which prints a plan and changes nothing (in a fork of the VM with `pnpm apply --fork` on a paid CreateOS plan). The script refuses to act with anything but a Stripe test-mode key, and the CLI and the VM server check that too.
6. The report is served from inside the sandbox over its public HTTPS URL, behind a random token *(verify live)*. Its **Dry run** and **Apply in test mode** buttons call the VM's own server. Apply runs once per sandbox.

## Run it

```bash
pnpm install
stripe projects init leakfinder --skip-skills
stripe projects add createos/project          # (verify live: service ids and env var names)
stripe projects add neon/postgres
stripe projects env --pull                     # writes .env
# then put a model key (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY) and a Stripe test key (STRIPE_SECRET_KEY=sk_test_...) in .env.local
pnpm check            # opens a sealed sandbox, proves the seal, reaches Stripe and Postgres from inside, destroys it
pnpm seed:starter     # nextjs/saas-starter's schema with planted drift (src/starters/saas-starter.ts says what)
pnpm verify:starter   # independent count: 12 / 3 / 5 and $348 a month
pnpm scan             # the agent writes and runs the reconciliation, then serves the report
pnpm apply            # dry run; add --yes to repair, in Stripe test mode
pnpm verify:starter   # the drift, recounted without the agent
# the second schema: pnpm seed && pnpm scan && pnpm verify
pnpm down             # destroy the run's sandbox
```

Or, in your own project directory with the same `.env`: `npx leakfinder audit`, `npx leakfinder apply --yes` *(verify live: npm publish pending)*.

Both seeds need a Stripe account in test mode with no other subscriptions, because the audit reads every subscription in the account. It tags every object it creates (`leakfinder_seed`), retires earlier seeded objects first, and never deletes anything it did not create.

Other commands: `pnpm serve` re-serves the last report from the sandbox, `pnpm report` re-renders it locally, `pnpm demo` runs the audit and prints the report URL, `pnpm spike` smoke-tests the CreateOS calls with one sandbox, `pnpm test` runs the unit tests.

## Verify it yourself

```bash
pnpm verify:starter   # drift computed in TypeScript from Postgres and Stripe, no model (pnpm verify for the second schema)
grep -c "$(jq -r .grep_target_email seed/expected.json)" "$(jq -r .runDir runs/last.json)/transcript.jsonl"   # expect 0
pnpm test        # guard, transcript, loop, report escaping, seed rules, VM server
```

`seed/expected.json` is the answer key. `pnpm seed:starter` (or `pnpm seed`) writes it, it is not committed, and the report scores the agent's findings against it.

## What is real and what is not

- **Real:** the agent loop, the CreateOS sandbox and its egress rules, the Stripe test API, the transcript and the grep, the report served from the sandbox *(verify live)*.
- **Demo data:** every user, team, subscription and the drift itself is seeded by this repo. The main schema is nextjs/saas-starter's, unmodified; the second follows the users/customers/products/prices/subscriptions shape of Vercel's Supabase billing starter, plus an `entitlements` table.
- **Not claimed:** real money (test mode only); collected payments (invoices are sent, not paid); schemas beyond the two in this repo; that every personal field is caught (email addresses are removed; the prompt keeps other fields out).
- **Known gaps:** DNS lookups to the VM's resolver are allowed, so a hostile script could leak data through DNS queries. The database credential is the app's own; a read-only role would be safer for the audit. Forking the VM for the dry run needs a paid CreateOS plan; by default the dry run runs in the same VM, which is safe because `APPLY` is off.

## Layout

- `src/sandbox.ts` the sealed room: create, seal, run, serve, fork, destroy
- `src/agent.ts` the loop: the model writes Python, the VM runs it, guarded output goes back
- `src/llm.ts` the guard and the transcript
- `src/skills.ts` saved working scripts, keyed by schema fingerprint
- `src/report.ts` the report page; `src/score.ts` planted versus found
- `seed/saas-starter.sql` the starter's schema, verbatim; `src/starters/saas-starter.ts` its seed and recount
- `src/seed.ts` the second schema's seed; `src/verify.ts` its independent recount
- `vm/server.py` the small server inside the sandbox that serves the report and runs Apply
- `src/cli.ts` the commands

## Built with

- **Stripe Projects:** provisions CreateOS and Postgres from the terminal and writes `.env` *(verify live)*.
- **CreateOS Sandbox:** the micro-VM where the agent's code runs: egress allowlist, public URL for the report, auto-pause when idle, and fork on a paid plan.
- **Stripe API, test mode:** reads subscriptions; writes invoices, refunds and cancellations.
- **The model:** DeepSeek (`deepseek-v4-pro`, the demo's) or Claude (`claude-sonnet-5-5`) writes and repairs the Python. Whichever key is present picks it (Claude if both are); override with `LEAKFINDER_PROVIDER` and `LEAKFINDER_MODEL`. Either way it only ever sees code, schema, counts and errors.
- **TypeScript on Node** for the orchestrator, **Python 3.13** inside the VM.

## Built with AI assistance

Code in this repository is written with Claude Code during the event. Decisions and testing are the author's.

## License

MIT
