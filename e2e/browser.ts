// Runs in a browser against a real kdoq process; started by run.py, not by `bun test`.
import { type Config, runScenario } from "./scenario";

const config: Config = await (await fetch("/config")).json();
const outcome = await runScenario(config);
document.body.textContent = JSON.stringify(outcome, null, 2);
await fetch("/result", { method: "POST", body: JSON.stringify(outcome) });
