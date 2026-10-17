# Deploying the LeakFinder site

`site/index.html` is one static page: no build step, no external requests. `Dockerfile` and `nginx.conf` serve it on port 8080 so CreateOS can run it as an upload project. The page is live on Vercel (see Next steps). CreateOS hosting (section 1) has not been tried; its commands are for Raj to run.

## Next steps

- Vercel (deployed 04:51 IST, 2026-10-18): https://leakfinder-nu.vercel.app. Production deployment, checked anonymously: 200, the title and hero render, no console errors, and `.env*`, `.vercel`, `DEPLOY.md`, `Dockerfile` and `nginx.conf` all 404. Share this URL only. The other aliases (`leakfinder-rajkaria67-1831s-projects.vercel.app` and each `leakfinder-<hash>-...vercel.app`) redirect to a Vercel login.
- Redeploy after any change to the page: `cd site && vercel deploy --prod --yes`. `site/` is linked to the Vercel project `leakfinder`; the link lives in `site/.vercel`, which is gitignored, so a fresh checkout links again on its first deploy (pick the existing `leakfinder` project).
- After the first full audit in the CreateOS sandbox: fill the sample run (section 3), rewrite the "Not run live yet" item in the Status list as "Run live", and redeploy.

Docs references are line numbers in `createos-internal/hackathon/_createos-docs-full.md`. CLI facts come from `createos --help` (v0.0.31, installed at `/opt/homebrew/bin/createos`).

## 0. Look at it locally (optional)

```bash
python3 -m http.server 8080 --directory site    # then open http://localhost:8080
```

## 1. CreateOS (preferred: the sponsor hosts it)

Sign in once. Browser OAuth is simplest (docs L869, L946):

```bash
createos login
createos whoami
```

The CLI also takes a key from `CREATEOS_API_KEY` (see `createos --help`, global `--api-key`), so a key that Stripe Projects wrote to `.env` works too (docs L18882). Do not print it on screen.

Create the project once. `createos projects add --help` documents upload projects and lists `dockerfile` as a runtime value:

```bash
createos projects add \
  --name "LeakFinder" \
  --unique-name leakfinder \
  --type upload \
  --runtime dockerfile \
  --port 8080 \
  --description "An AI agent that finds money leaking between Stripe and your database."
createos projects list            # copy the project id
```

If `leakfinder` is taken, use `leakfinder-site` (lowercase, 4 to 32 characters). If the CLI rejects `--runtime dockerfile`, run `createos projects add` with no flags in a terminal: it walks through each step. Pick upload, the Dockerfile or static option it offers, and port 8080.

Deploy from the repo root. `--project` plus `--dir` means no `createos init`, so no `.createos.json` and no `.gitignore` edit in the repo (docs L1003, L1099 to L1102):

```bash
createos deploy --project <project-id> --dir site
```

Build logs stream, then the CLI prints `Live at: https://...` (docs L1018). Check it:

```bash
createos status --project <project-id>
createos deployments list --project <project-id> -o json | jq -r '.[0].extra.endpoint'   # docs L1542
```

Before the demo and before judging, open the URL once. A deployment can sleep; wake it with `createos deployments wakeup --project <project-id>` (add `--deployment <id>` from `deployments list` if it asks; docs L1175).

Dashboard route, if the CLI path fails: createos.sh/app, Deploy, **Deploy using File Upload**, upload a zip of the site, set port 8080, Deploy. File uploads always use Build with AI (docs L18995 to L18999, L2283 to L2300).

```bash
(cd site && zip -r ../leakfinder-site.zip index.html Dockerfile nginx.conf)
```

## 2. Vercel (live)

```bash
cd site && vercel deploy --prod --yes
```

The project `leakfinder` already exists, with no framework and no build command; the output is `site/` itself. Without a `site/.vercel` link the CLI asks to link: pick the scope and the existing `leakfinder` project. `vercel link` also writes a `site/.env.local` with a short-lived OIDC token; `site/.gitignore` keeps it out of git and `.vercelignore` keeps it out of the upload, along with `.vercel`, `Dockerfile`, `nginx.conf` and this file. Share https://leakfinder-nu.vercel.app, not the URL the CLI prints: that one is per deployment and sits behind Vercel's login. Check the public URL in a private window after each deploy.

## 3. After the first live run

1. In `site/index.html`, paste a real terminal excerpt and a real report link at `<!-- SAMPLE-RUN -->` (escape `<`, `>` and `&` in the terminal text; the comment above the section shows the markup).
2. Remove `hidden` from `<section class="section" id="sample-run" ...>`.
3. Redeploy with the same command as above.

Do not paste the report URL with its `?k=` token, and nothing with a customer email.

## Not confirmed yet

- `--runtime dockerfile` for upload projects comes from the CLI help, not the docs. The deploy API's settings object has `hasDockerfile` (docs L21781), which suggests a Dockerfile in the upload is honoured.
- The public hostname. The docs show both `*.nodeops.app` (L1018) and `*.createos.nodeops.network` (L2271). Use whatever `createos deploy` prints.
- The Dockerfile and `nginx.conf` were not built locally (no Docker on this machine). The image is the stock `nginx:1.27-alpine` with one server block. The docs' "no COPY" rule applies to sandbox templates (L5546), not to deploy projects.
- Whether a deployed project counts against the Free plan's sandbox limit. Sandboxes and deployments look like separate products in the docs, but check `createos status` if the audit's sandbox create starts failing.
