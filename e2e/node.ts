// Node entry of the end-to-end scenario; bundled and started by run-bun.ts with the connection
// settings as its argument.
import { type Config, runScenario } from "./scenario";
import { loadTransport } from "./transport";

const config: Config = JSON.parse(process.argv[2]);
const transport = await loadTransport();
const outcome = await runScenario(config, transport);
console.log(JSON.stringify(outcome, null, 2));
if (!outcome.ok) process.exitCode = 1;
