// eval/framework.mjs — micro eval framework for DSH plugins.
//
// Two kinds of cases, one runner:
//   - behavior: deterministic scenario checks that run the plugin's apply()
//     against a fake ctx (free, no tokens).
//   - llm: optional checks on real model output (needs DEEPSEEK_API_KEY,
//     costs tokens). Run with `npm run eval:llm`.
//
// Case files live in eval/cases/ and export `cases` (an array). A behavior
// case is { name, run(t) } where t provides fakeCtx(config, services),
// runCommand and assert. An llm case is { kind: "llm", name, prompt, system?,
// model?, checks: [{ type, value }] }.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";
import { createFakeCtx } from "../test/helpers.mjs";

// Rough peak prices (USD per 1M tokens) used to estimate LLM eval cost.
const PRICE_INPUT_PER_M = 0.44;
const PRICE_OUTPUT_PER_M = 1.32;

/** Build the harness handed to behavior cases. */
export function behaviorHarness() {
  return {
    fakeCtx(config = {}, services = {}) {
      const ctx = createFakeCtx(services);
      apply(ctx, config);
      return ctx;
    },
    assert,
  };
}

/** Import every *.mjs under dir and collect its exported cases. */
export async function loadCases(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".mjs")) continue;
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    for (const c of mod.cases ?? []) out.push(c);
  }
  return out;
}

/** Run one behavior case; never throws, returns a result record. */
export async function runBehaviorCase(c) {
  const t = behaviorHarness();
  const started = Date.now();
  try {
    await c.run(t);
    return { name: c.name, status: "pass", ms: Date.now() - started };
  } catch (error) {
    return {
      name: c.name,
      status: "fail",
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check a model output against a list of checks.
 * @param text Model output.
 * @param checks [{ type, value }] with types include|exclude|regex|length-lte|length-gte.
 * @returns array of failure messages (empty = pass).
 */
export function checkOutput(text, checks) {
  const failures = [];
  for (const check of checks ?? []) {
    const { type, value } = check;
    if (type === "include") {
      if (!text.includes(value)) failures.push("expected to include " + JSON.stringify(value));
    } else if (type === "exclude") {
      if (text.includes(value)) failures.push("expected NOT to include " + JSON.stringify(value));
    } else if (type === "regex") {
      if (!new RegExp(value).test(text)) failures.push("expected to match /" + value + "/");
    } else if (type === "length-lte") {
      if (text.length > value) failures.push("length " + text.length + " > " + value);
    } else if (type === "length-gte") {
      if (text.length < value) failures.push("length " + text.length + " < " + value);
    } else {
      failures.push("unknown check type: " + type);
    }
  }
  return failures;
}

/**
 * Run one LLM case against the DeepSeek chat API. Throws on transport errors;
 * check failures come back in the result record.
 */
export async function runLlmCase(c, { apiKey, baseUrl, model }) {
  const started = Date.now();
  const url = baseUrl + "/chat/completions";
  const messages = [];
  if (c.system) messages.push({ role: "system", content: c.system });
  messages.push({ role: "user", content: c.prompt });
  // Manual timeout: AbortSignal.timeout() leaves a pending timer that makes
  // process.exit() crash on Windows (0xC0000409). Clear it once settled.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        // Close each connection: pooled keep-alive sockets make forced
        // process.exit() crash on Windows (0xC0000409).
        Connection: "close",
      },
      body: JSON.stringify({
        model: c.model ?? model,
        messages,
        max_tokens: c.maxTokens ?? 200,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error("HTTP " + response.status + ": " + text.slice(0, 300));
  }
  const data = await response.json();
  const output = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cost =
    (promptTokens / 1_000_000) * PRICE_INPUT_PER_M +
    (completionTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  const failures = checkOutput(output, c.checks);
  return {
    name: c.name,
    status: failures.length === 0 ? "pass" : "fail",
    ms: Date.now() - started,
    output: output.slice(0, 200),
    tokens: promptTokens + completionTokens,
    cost,
    failures,
  };
}

/** Render a plain-text summary of results. */
export function formatResults(results, { showOutput = false } = {}) {
  const lines = [];
  let pass = 0;
  let totalCost = 0;
  let totalTokens = 0;
  for (const r of results) {
    if (r.status === "pass") pass++;
    totalCost += r.cost ?? 0;
    totalTokens += r.tokens ?? 0;
    lines.push((r.status === "pass" ? "✓" : "✗") + " " + r.name + " (" + r.ms + "ms)");
    if (r.failures?.length) {
      for (const f of r.failures) lines.push("    - " + f);
    }
    if (showOutput && r.output !== undefined) lines.push("    output: " + JSON.stringify(r.output));
    if (r.error) lines.push("    error: " + r.error);
  }
  lines.push("—".repeat(48));
  lines.push("pass " + pass + "/" + results.length);
  if (totalTokens > 0) {
    lines.push("tokens " + totalTokens + ", est. cost $" + totalCost.toFixed(4));
  }
  return lines.join("\n");
}
