#!/usr/bin/env -S node --import tsx
import { runCli } from "./cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
