#!/usr/bin/env node
// npx leakfinder <audit|apply|serve|report|demo|doctor|down>
// Hints name the command the user typed (`npx leakfinder audit`), not the repo's pnpm scripts.
process.env.LEAKFINDER_CLI ??= "npx leakfinder";
await import("../dist/cli.js");
