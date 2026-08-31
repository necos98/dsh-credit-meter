// eval/run.mjs — eval entry point.
//   node eval/run.mjs          → behavior evals only (free)
//   node eval/run.mjs --llm    → behavior + LLM evals (needs DEEPSEEK_API_KEY)
//   node eval/run.mjs --case X → run only cases whose name includes X
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatResults, loadCases, runBehaviorCase, runLlmCase } from "./framework.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const wantLlm = args.includes("--llm");
const filter = args.includes("--case")
  ? args[args.indexOf("--case") + 1]
  : null;

const cases = await loadCases(path.join(here, "cases"));
const selected = filter
  ? cases.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
  : cases;

if (selected.length === 0) {
  console.error("no cases" + (filter ? " matching " + JSON.stringify(filter) : ""));
  process.exit(1);
}

const results = [];
for (const c of selected) {
  if (c.kind === "llm") {
    if (!wantLlm) continue;
    const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
    if (!apiKey) {
      results.push({ name: c.name, status: "fail", error: "DEEPSEEK_API_KEY not set (npm run eval:llm)" });
      continue;
    }
    try {
      results.push(
        await runLlmCase(c, {
          apiKey,
          baseUrl: process.env.EVAL_BASE_URL ?? "https://api.deepseek.com",
          model: process.env.EVAL_MODEL ?? "deepseek-chat",
        })
      );
    } catch (error) {
      results.push({
        name: c.name,
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    results.push(await runBehaviorCase(c));
  }
}

console.log(formatResults(results, { showOutput: wantLlm }));
const failed = results.filter((r) => r.status === "fail");
process.exit(failed.length > 0 ? 1 : 0);
