import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS } from "../questions.js";
import { GOAL_QUESTIONS, OPENAI_MODEL, CONTEXT_SCHEMA, parseContext, normalizeAdvice } from "../guidance.js";

const sender = { id: "test-extension", tab: { id: 1 }, frameId: 0, url: "https://x.com/home" };
const options = { id: "test-extension", url: "chrome-extension://test-extension/options.html" };
const state = { post: "A new chip has 12 cores.", author: { handle: "@example" }, post_metadata: { tweet_id: "123" } };
export function fixture() {
  return { model: "jev-1.13.0", usage: { input_tokens: 123, output_tokens: 45 }, answers: Object.fromEntries(
    Object.entries(QUESTIONS).map(([id, q]) => [id, q.type === "noul" ? { type: "noul", noul: 0.98 } : q.type === "choice" ?
      { type: "choice", choice: "technical_reporting", confidence: 0.9, probabilities: { technical_reporting: 0.9, opinion: 0.1 } } :
      { type: "score", score: 2.14, confidence: 0.8, legend: Object.fromEntries(q.criteria.map((text, i) => [i, text])), probabilities: { 0: 0.1, 1: 0.1, 2: 0.4, 3: 0.36, 4: 0.04 } }])
  ) };
}
let moduleId = 0;
async function setup({ accessFails = false } = {}) {
  const data = {};
  const requests = [];
  let accessLevel;
  let listener;
  globalThis.chrome = {
    storage: { local: {
      async setAccessLevel(value) { if (accessFails) throw Error("denied"); accessLevel = value.accessLevel; },
      async get(key) { return key === null ? { ...data } : { [key]: data[key] }; },
      async set(value) { assert.equal(accessLevel, "TRUSTED_CONTEXTS"); Object.assign(data, value); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    } },
    runtime: { id: sender.id, getURL: file => `chrome-extension://${sender.id}/${file}`, openOptionsPage: async () => {},
      onMessage: { addListener(fn) { listener = fn; } } },
    action: { onClicked: { addListener() {} } }
  };
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(fixture())); };
  const worker = await import(`../background.js?test=${++moduleId}`);
  const send = (message, from = sender) => new Promise(resolve => listener(message, from, resolve));
  return { worker, data, requests, send };
}

test("Options alone save keys; cache lookup never makes an API call", async () => {
  const { send, data, requests } = await setup();
  assert.equal((await send({ type: "SAVE_KEY", key: "private-key" })).ok, false);
  assert.equal((await send({ type: "SAVE_KEY", key: "private-key" }, options)).ok, true);
  assert.equal(data.jevApiKey, "private-key");
  assert.deepEqual(await send({ type: "SETTINGS_STATUS" }, options), { ok: true, hasKey: true, hasOpenAIKey: false, timeline: { goal: "", enabled: false } });
  assert.deepEqual(await send({ type: "GET_CACHED", state }), { ok: true, result: null });
  assert.equal(requests.length, 0);
});

test("exact API contract, one request for concurrent clicks, and cache survives worker restart", async () => {
  const { send, data, requests } = await setup();
  await send({ type: "SAVE_KEY", key: "private-key" }, options);
  const replies = await Promise.all([send({ type: "ANALYZE", state }), send({ type: "ANALYZE", state })]);
  assert.ok(replies.every(r => r.ok));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(requests[0].init.headers.Authorization, "Bearer private-key");
  assert.equal(requests[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(requests[0].init.body), { state, model: "jev-latest", questions: QUESTIONS });
  assert.ok(!JSON.stringify(replies).includes("private-key"));
  await import(`../background.js?test=${++moduleId}`);
  assert.equal((await send({ type: "ANALYZE", state })).cached, true);
  assert.equal(requests.length, 1);
  assert.ok(Object.keys(data).some(k => k.endsWith("tweet:123")));
});

test("fallback hash is stable, sensitive to author/text, ignores mutable metrics", async () => {
  const { worker } = await setup();
  const base = { post: "hello", author: { handle: "@alice" } };
  assert.equal(await worker.cacheKey(base), await worker.cacheKey({ ...base, post_metadata: { views: "200" } }));
  assert.notEqual(await worker.cacheKey(base), await worker.cacheKey({ ...base, post: "bye" }));
  assert.notEqual(await worker.cacheKey(base), await worker.cacheKey({ ...base, author: { handle: "@bob" } }));
});

test("missing key, empty text, and untrusted senders cannot call Jev", async () => {
  const { send, requests } = await setup();
  assert.match((await send({ type: "ANALYZE", state })).error, /API key/);
  for (const from of [{ ...sender, url: "https://evil.test" }, { ...sender, id: "other" }, { ...sender, frameId: 1 }]) {
    assert.equal((await send({ type: "ANALYZE", state }, from)).ok, false);
  }
  assert.equal((await send({ type: "ANALYZE", state: { post: "" } })).ok, false);
  assert.equal(requests.length, 0);
});

test("storage access failure prevents credential writes and network calls", async () => {
  const { send, data, requests } = await setup({ accessFails: true });
  assert.equal((await send({ type: "SAVE_KEY", key: "secret" }, options)).ok, false);
  assert.deepEqual(data, {});
  assert.equal(requests.length, 0);
});

test("error bodies are never echoed and failed requests can be retried", async () => {
  const { send, data } = await setup();
  await send({ type: "SAVE_KEY", key: "private-key" }, options);
  globalThis.fetch = async () => new Response("private-key", { status: 401 });
  const failure = await send({ type: "ANALYZE", state });
  assert.match(failure.error, /rejected/);
  assert.ok(!JSON.stringify(failure).includes("private-key"));
  assert.equal(Object.keys(data).length, 1);
  globalThis.fetch = async () => new Response(JSON.stringify(fixture()));
  assert.equal((await send({ type: "ANALYZE", state })).ok, true);
});

test("rate limiting enforces a cooldown without automatic retries", async () => {
  const { send } = await setup();
  await send({ type: "SAVE_KEY", key: "private-key" }, options);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("busy", { status: 429, headers: { "Retry-After": "120" } }); };
  assert.match((await send({ type: "ANALYZE", state })).error, /rate limited/);
  assert.match((await send({ type: "ANALYZE", state })).error, /rate limited/);
  assert.equal(calls, 1);
});

test("rejects malformed answers and strips arbitrary response fields", async () => {
  const { worker } = await setup();
  const body = fixture();
  body.answers.sensationalism.secret = "secret";
  assert.ok(!JSON.stringify(worker.normalizeAnswers(body)).includes("secret"));
  body.answers.post_type.choice = "<script>bad</script>";
  assert.throws(() => worker.normalizeAnswers(body));
  for (const value of [-1, 5, "2", NaN]) {
    const invalid = fixture();
    invalid.answers.sensationalism.score = value;
    assert.throws(() => worker.normalizeAnswers(invalid));
  }
  assert.throws(() => worker.normalizeAnswers({ answers: {} }));
});

test("bounded cache evicts oldest entries and clearing cache preserves key", async () => {
  const { send, data } = await setup();
  await send({ type: "SAVE_KEY", key: "private-key" }, options);
  for (let i = 0; i < 500; i++) data[`postlens:v1:tweet:${i + 1000}`] = { savedAt: i, answers: fixture().answers };
  await send({ type: "ANALYZE", state });
  assert.equal(Object.keys(data).filter(k => k.startsWith("postlens:")).length, 500);
  assert.equal(data["postlens:v1:tweet:1000"], undefined);
  assert.equal((await send({ type: "CLEAR_CACHE" }, options)).ok, true);
  assert.deepEqual(data, { jevApiKey: "private-key" });
});

test("state whitelist drops unrelated page data and never invents missing metadata", async () => {
  const { worker } = await setup();
  assert.deepEqual(worker.cleanState({ post: "hello", author: { verified: false }, unrelated: "secret" }), { post: "hello" });
});

const context = {
  summary: "The post claims a chip has 12 cores.", topics: ["hardware"],
  goal_relation: "Hardware specifications may help the user's engineering goal.",
  potential_value: "A concrete specification to investigate.", potential_downside: "No benchmark or source is visible.",
  uncertainties: ["The specification has not been verified.", "The author's other posts are unknown."]
};
const contextResponse = () => ({ status: "completed", output: [
  { type: "reasoning", summary: [] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(context) }] }
] });
const goalResponse = (choice = "like_follow", confidence = 0.9) => ({ answers: {
  goal_alignment: { type: "score", score: 3.6, confidence: 0.85 },
  suggested_action: { type: "choice", choice, confidence }
} });
async function enableAdvice(send) {
  await send({ type: "SAVE_KEY", key: "jev-private-key" }, options);
  await send({ type: "SAVE_KEY", provider: "openai", key: "openai-private-key" }, options);
  await send({ type: "SAVE_TIMELINE", goal: "Learn practical hardware engineering", enabled: true }, options);
}
function mockPipeline(calls) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    return new Response(JSON.stringify(url.includes("openai.com") ? contextResponse() : body.questions.goal_alignment ? goalResponse() : fixture()));
  };
}

test("only Options can set OpenAI credentials or timeline goals; no key is returned", async () => {
  const { send, data } = await setup();
  assert.equal((await send({ type: "SAVE_KEY", provider: "openai", key: "openai-private-key" })).ok, false);
  assert.equal((await send({ type: "SAVE_TIMELINE", goal: "anything", enabled: true })).ok, false);
  assert.equal((await send({ type: "SAVE_TIMELINE", goal: " ", enabled: true }, options)).ok, false);
  assert.equal((await send({ type: "SAVE_TIMELINE", goal: "x".repeat(1001), enabled: true }, options)).ok, false);
  await enableAdvice(send);
  const status = await send({ type: "SETTINGS_STATUS" }, options);
  assert.equal(status.hasOpenAIKey, true);
  assert.ok(!JSON.stringify(status).includes("private-key"));
  await send({ type: "REMOVE_KEY", provider: "openai" }, options);
  assert.equal(data.openaiApiKey, undefined);
  assert.equal(data.jevApiKey, "jev-private-key");
});

test("optional pipeline keeps original Jev scores independent and feeds validated Luna context to goal questions", async () => {
  const { send } = await setup();
  await enableAdvice(send);
  const calls = [];
  mockPipeline(calls);
  assert.deepEqual(await send({ type: "GET_CACHED", state }), { ok: true, result: null });
  assert.equal(calls.length, 0);
  const [first, second] = await Promise.all([send({ type: "ANALYZE", state }), send({ type: "ANALYZE", state })]);
  assert.equal(first.result.advice.action, "like_follow");
  assert.deepEqual(first.result, second.result);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body, { state, model: "jev-latest", questions: QUESTIONS });
  const openai = calls.find(call => call.url.includes("openai.com"));
  assert.equal(openai.url, "https://api.openai.com/v1/responses");
  assert.equal(openai.init.headers.Authorization, "Bearer openai-private-key");
  assert.equal(openai.body.model, OPENAI_MODEL);
  assert.equal(openai.body.store, false);
  assert.deepEqual(openai.body.text.format.schema, CONTEXT_SCHEMA);
  assert.equal(openai.body.text.format.strict, true);
  assert.equal(openai.body.tools, undefined);
  assert.ok(!JSON.stringify(openai.body).includes("private-key"));
  const goal = calls.find(call => call.body.questions?.goal_alignment);
  assert.deepEqual(goal.body.questions, GOAL_QUESTIONS);
  assert.equal(goal.init.headers.Authorization, "Bearer jev-private-key");
  assert.equal(goal.body.state.model_interpretation.summary, context.summary);
  assert.deepEqual(goal.body.state.post_analysis, first.result.answers);
  assert.ok(!JSON.stringify(first).includes("private-key"));
  assert.equal((await send({ type: "GET_CACHED", state })).result.advice.action, "like_follow");
  await send({ type: "ANALYZE", state });
  assert.equal(calls.length, 3);
});

test("changing goals invalidates advice only; disabling advice removes it without calls", async () => {
  const { send } = await setup();
  await enableAdvice(send);
  const calls = []; mockPipeline(calls);
  await send({ type: "ANALYZE", state });
  await send({ type: "SAVE_TIMELINE", goal: "Find thoughtful hardware criticism", enabled: true }, options);
  const cached = await send({ type: "GET_CACHED", state });
  assert.equal(cached.result.advice, undefined);
  assert.equal(cached.result.adviceAvailable, true);
  assert.equal(calls.length, 3);
  await send({ type: "ANALYZE", state });
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(call => call.body.questions?.contains_factual_claim).length, 1);
  await send({ type: "SAVE_TIMELINE", goal: "Find thoughtful hardware criticism", enabled: false }, options);
  assert.equal((await send({ type: "ANALYZE", state })).result.advice, undefined);
  assert.equal(calls.length, 5);
});

test("saved OpenAI key alone does not enable enrichment or send posts to OpenAI", async () => {
  const { send, requests } = await setup();
  await send({ type: "SAVE_KEY", key: "jev-private-key" }, options);
  await send({ type: "SAVE_KEY", provider: "openai", key: "openai-private-key" }, options);
  await send({ type: "ANALYZE", state });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes("typesafe.ai"));
});

test("OpenAI failures preserve and cache original scores; explicit retry does not repeat base analysis", async () => {
  const { send } = await setup();
  await enableAdvice(send);
  let baseCalls = 0;
  globalThis.fetch = async url => {
    if (url.includes("openai.com")) return new Response("openai-private-key", { status: 401 });
    baseCalls++;
    return new Response(JSON.stringify(fixture()));
  };
  const result = await send({ type: "ANALYZE", state });
  assert.equal(result.ok, true);
  assert.equal(result.result.answers.contains_factual_claim.noul, 0.98);
  assert.match(result.result.adviceError, /OpenAI rejected/);
  assert.ok(!JSON.stringify(result).includes("openai-private-key"));
  const calls = []; mockPipeline(calls);
  assert.ok((await send({ type: "ANALYZE", state })).result.advice);
  assert.equal(calls.length, 2);
  assert.equal(baseCalls, 1);
});

test("in-flight advice is discarded after a goal change", async () => {
  const { send } = await setup();
  await enableAdvice(send);
  let release;
  let started;
  const waitStarted = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (url, init) => {
    if (url.includes("openai.com")) {
      started();
      await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify(contextResponse()));
    }
    return new Response(JSON.stringify(JSON.parse(init.body).questions.goal_alignment ? goalResponse() : fixture()));
  };
  const pending = send({ type: "ANALYZE", state });
  await waitStarted;
  await send({ type: "SAVE_TIMELINE", goal: "Learn something else", enabled: true }, options);
  release();
  const result = await pending;
  assert.equal(result.result.advice, undefined);
  assert.match(result.result.adviceError, /goal changed/);
});

test("context parser handles reasoning items, refusals, truncation, malformed and oversized output", () => {
  assert.deepEqual(parseContext(contextResponse()), context);
  assert.throws(() => parseContext({ ...contextResponse(), status: "incomplete" }));
  assert.throws(() => parseContext({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] }));
  for (const text of ["not json", JSON.stringify({ ...context, summary: "x".repeat(501) }), JSON.stringify({ ...context, uncertainties: [42] })]) {
    assert.throws(() => parseContext({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }));
  }
});

test("low-confidence recommendations become review and invented actions are rejected", () => {
  assert.equal(normalizeAdvice(goalResponse("mute", 0.5), context).action, "review");
  assert.equal(normalizeAdvice(goalResponse("like", 0.9), context).action, "like");
  const weak = goalResponse("like_follow", 0.95);
  weak.answers.goal_alignment.score = 2;
  assert.equal(normalizeAdvice(weak, context).action, "review");
  assert.throws(() => normalizeAdvice(goalResponse("delete_account"), context));
  assert.throws(() => normalizeAdvice(goalResponse("like", NaN), context));
});

test("unexpected credential echoes in generated context never reach Jev or the page", async () => {
  const { send } = await setup();
  await enableAdvice(send);
  let jevCalls = 0;
  globalThis.fetch = async url => {
    if (!url.includes("openai.com")) { jevCalls++; return new Response(JSON.stringify(fixture())); }
    const body = contextResponse();
    body.output[1].content[0].text = JSON.stringify({ ...context, summary: "openai-private-key" });
    return new Response(JSON.stringify(body));
  };
  const reply = await send({ type: "ANALYZE", state });
  assert.equal(reply.ok, true);
  assert.equal(jevCalls, 1);
  assert.equal(reply.result.advice, undefined);
  assert.ok(!JSON.stringify(reply).includes("openai-private-key"));
});
