#!/usr/bin/env node
// node bench/selftest.mjs [--track employee|builder] [--native]: proves the graders before any model is run.
import "./lib/register.mjs";
const { selftest } = await import("./lib/selftest.ts");
process.exit(await selftest(process.argv.slice(2)));
