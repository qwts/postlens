import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS } from "../questions.js";

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
  assert.deepEqual(await send({ type: "SETTINGS_STATUS" }, options), { ok: true, hasKey: true });
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
