# LeakFinder

> LeakFinder is an AI agent that finds money leaking between Stripe and your database. It writes its own code and runs it in a sealed CreateOS sandbox.

Built in one day for the CreateOS × Stripe Projects hackathon (2026-10-17 PT). Status: building. Anything marked *(verify live)* has not yet run against real services.

## What it does

A SaaS app records who has Pro in its own database and who pays in Stripe. When a webhook is missed or was never verified, the two stop matching. In the demo data the database says 48 users have Pro. Stripe has 39 paying subscriptions, and only 36 of them belong to those users. The gap hides three problems:

| | What drifted | Demo data |
|---|---|---|
| A | Pro access nobody pays for (7 never paid, 5 cancelled in Stripe without the app hearing) | 12 users, $348 a month |
| B | People paying with no account to log in to | 3 subscriptions |
| C | App rows that say `active` while Stripe says `canceled` | 5 rows |

LeakFinder reads your schema, writes Python that reconciles it with every Stripe subscription, runs that Python in a CreateOS micro-VM, and shows you the people and the dollars. Then it writes a fix, dry-runs it, and applies it in Stripe test mode when you say so.

## Three things to check

1. **The agent writes and fixes its own code, in a sealed room.** The sandbox can reach `api.stripe.com` and your database's addresses on its port. Everything else is dropped on the host, outside the VM, so code inside cannot change the rule. When a query fails, the agent reads the error and rewrites the script.
2. **The model never sees a customer.** It gets code, schema, counts and error text, with email addresses redacted before anything leaves your machine for the model. Every byte it was shown is saved in `runs/<run>/transcript.jsonl`, and the audit greps that file for a planted customer email.
3. **Apply recovers the money, in Stripe test mode.** Unpaid Pro access is revoked and invoiced, people paying with no account are refunded and cancelled, stale rows are synced. `pnpm verify` then recounts the drift straight from Postgres and Stripe, with no model involved *(verify live: zeros after Apply)*.

## How it works

1. `stripe projects` provisions the stack from the terminal: CreateOS and a Postgres database, with credentials written to `.env` *(verify live)*.
2. LeakFinder opens one CreateOS micro-VM with the outbound allowlist set at create time: `api.stripe.com`, the database's IPv4 addresses on its port, and the VM's DNS resolver. Before any model-written code runs, LeakFinder tests the lock from inside: `example.com` gets no answer and `api.stripe.com` does.
3. The model writes Python for your schema, the VM runs it, and only the exit code, counts and error text go back, with email addresses removed. A failing script is rewritten, up to eight turns. A working script is saved for that schema, so the next run on it needs no model turns.
4. Findings are written to a file inside the VM. The report is built from that file.
5. The model writes a fix script. It runs first with `APPLY` off, which prints a plan and changes nothing, in a fork of the VM when your plan allows forks. The script refuses to act with anything but a Stripe test-mode key, and the CLI and the VM server check that too.
6. The report is served from inside the sandbox over its public HTTPS URL, behind a random token *(verify live)*. Its **Dry run** and **Apply in test mode** buttons call the VM's own server. Apply runs once per sandbox.

## Run it

```bash
pnpm install
stripe projects init leakfinder --skip-skills
stripe projects add createos/project          # (verify live: service ids and env var names)
stripe projects add neon/postgres
stripe projects env --pull                     # writes .env
# then add ANTHROPIC_API_KEY and a Stripe test key (STRIPE_SECRET_KEY=sk_test_...) to .env
pnpm check            # opens a sealed sandbox, proves the seal, reaches Stripe and Postgres from inside, destroys it
pnpm seed             # a demo SaaS with planted drift (src/seed.ts says exactly what is planted)
pnpm verify           # independent count: 12 / 3 / 5 and $348 a month
pnpm scan             # the agent writes and runs the reconciliation, then serves the report
pnpm apply            # dry run; add --yes to repair, in Stripe test mode
pnpm verify           # the drift, recounted without the agent
pnpm down             # destroy the run's sandbox
```

Or, in your own project directory with the same `.env`: `npx leakfinder audit`, `npx leakfinder apply --yes` *(verify live: npm publish pending)*.

`pnpm seed` needs a Stripe account in test mode with no other subscriptions, because the audit reads every subscription in the account. It tags every object it creates (`leakfinder_seed`), retires earlier seeded objects first, and never deletes anything it did not create.

Other commands: `pnpm serve` re-serves the last report from the sandbox, `pnpm report` re-renders it locally, `pnpm demo` runs the audit and prints the report URL, `pnpm spike` smoke-tests the CreateOS calls with one sandbox, `pnpm test` runs the unit tests.

## Verify it yourself

```bash
pnpm verify      # drift computed in TypeScript from Postgres and Stripe, no model
grep -c "$(jq -r .grep_target_email seed/expected.json)" "$(jq -r .runDir runs/last.json)/transcript.jsonl"   # expect 0
pnpm test        # guard, transcript, loop, report escaping, seed rules, VM server
```

`seed/expected.json` is the answer key. `pnpm seed` writes it, it is not committed, and the report scores the agent's findings against it.

## What is real and what is not

- **Real:** the agent loop, the CreateOS sandbox and its egress rules, the Stripe test API, the transcript and the grep, the report served from the sandbox *(verify live)*.
- **Demo data:** every user, subscription and the drift itself is seeded by this repo. The schema follows the table shapes of a public SaaS billing starter (users, customers, products, prices, subscriptions) plus an `entitlements` table.
- **Not claimed:** real money (test mode only); collected payments (invoices are sent, not paid); other schemas (one schema is tested); that every personal field is caught (email addresses are removed; the prompt keeps other fields out).
- **Known gaps:** DNS lookups to the VM's resolver are allowed, so a hostile script could leak data through DNS queries. The database credential is the app's own; a read-only role would be safer for the audit. Forking the VM for the dry run needs the CreateOS Beginner plan; on Free the dry run runs in the original VM, which is safe because `APPLY` is off.

## Layout

- `src/sandbox.ts` the sealed room: create, seal, run, serve, fork, destroy
- `src/agent.ts` the loop: the model writes Python, the VM runs it, guarded output goes back
- `src/llm.ts` the guard and the transcript
- `src/skills.ts` saved working scripts, keyed by schema fingerprint
- `src/report.ts` the report page; `src/score.ts` planted versus found
- `src/seed.ts` the demo SaaS and its planted drift; `src/verify.ts` the independent recount
- `vm/server.py` the small server inside the sandbox that serves the report and runs Apply
- `src/cli.ts` the commands

## Built with

- **Stripe Projects:** provisions CreateOS and Postgres from the terminal and writes `.env` *(verify live)*.
- **CreateOS Sandbox:** the micro-VM where the agent's code runs: egress allowlist, public URL for the report, pause and fork.
- **Stripe API, test mode:** reads subscriptions; writes invoices, refunds and cancellations.
- **Claude (`claude-sonnet-5-5`):** writes and repairs the Python. Override with `LEAKFINDER_MODEL`.
- **TypeScript on Node** for the orchestrator, **Python 3.12** inside the VM.

## Built with AI assistance

Code in this repository is written with Claude Code during the event. Decisions and testing are the author's.

## License

MIT
