#!/usr/bin/env node
// node bench/run.mjs --track employee --model gpt-6.1-sol --effort low --trials 1 [--only id,id]
import "./lib/register.mjs";
const { main } = await import("./lib/run.ts");
process.exit(await main(process.argv.slice(2)));
