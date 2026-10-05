import { ignoreOutputErrors, runCli } from "./cli.ts";

ignoreOutputErrors();
process.exitCode = await runCli(process.argv.slice(2));
