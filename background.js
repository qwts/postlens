import { QUESTIONS } from "./questions.js";
import { OPENAI_ENDPOINT, OPENAI_MODEL, GUIDANCE_VERSION, GOAL_QUESTIONS, contextRequest, parseContext, normalizeAdvice, validateAdvice } from "./guidance.js";

// Endpoint is deliberately code-owned: page messages cannot redirect credentials.
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const CACHE_VERSION = "v1";
const CACHE_PREFIX = `postlens:${CACHE_VERSION}:`;
const MAX_CACHE_ENTRIES = 500;
const pending = new Map();
let cacheWrites = Promise.resolve();
let retryAfter = 0;
let openaiRetryAfter = 0;

// Must finish before reading/writing any credentials; fail closed on failure.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
storageReady.catch(() => {});

class UserError extends Error {}
const fail = (message) => { throw new UserError(message); };
const bounded = (value, max) => typeof value === "string" && value.length <= max ? value.trim() : "";

export function cleanState(input) {
  const post = bounded(input?.post, 30000);
  if (!post) fail("No visible post text to analyze. Images and video are not analyzed in V1.");
  const state = { post };
  const author = {};
  const displayName = bounded(input.author?.display_name, 200);
  const handle = bounded(input.author?.handle, 16);
  if (displayName) author.display_name = displayName;
  if (/^@[A-Za-z0-9_]{1,15}$/.test(handle)) author.handle = handle;
  if (input.author?.verified === true) author.verified = true;
  if (Object.keys(author).length) state.author = author;
  const metadata = {};
  const id = bounded(input.post_metadata?.tweet_id, 25);
  if (/^\d{1,25}$/.test(id)) metadata.tweet_id = id;
  const date = bounded(input.post_metadata?.posted_at, 40);
  if (date && Number.isFinite(Date.parse(date))) metadata.posted_at = date;
  const views = bounded(input.post_metadata?.views, 40);
  if (views) metadata.views = views;
  if (Object.keys(metadata).length) state.post_metadata = metadata;
  return state;
}

export async function cacheKey(state) {
  if (state.post_metadata?.tweet_id) return `${CACHE_PREFIX}tweet:${state.post_metadata.tweet_id}`;
  const identity = JSON.stringify([state.author?.handle || "", state.author?.display_name || "", state.post]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return `${CACHE_PREFIX}hash:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("")}`;
}

// Only typed post scores cross this boundary. Generated goal context uses a
// separate bounded schema; raw response envelopes and error bodies never cross.
export function normalizeAnswers(body) {
  const answers = {};
  const validNumber = (n, max) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
  for (const [id, question] of Object.entries(QUESTIONS)) {
    const answer = body?.answers?.[id];
    if (!answer || answer.type !== question.type) fail("Jev returned an unexpected response. Try again.");
    const clean = { type: question.type };
    if (question.type === "noul") {
      if (!validNumber(answer.noul, 1)) fail("Jev returned an invalid probability. Try again.");
      clean.noul = answer.noul;
    } else if (question.type === "score") {
      if (!validNumber(answer.score, question.criteria.length - 1)) fail("Jev returned an invalid score. Try again.");
      clean.score = answer.score;
    } else {
      if (!Object.hasOwn(question.criteria, answer.choice)) fail("Jev returned an invalid category. Try again.");
      clean.choice = answer.choice;
    }
    if (question.type !== "noul" && validNumber(answer.confidence, 1)) clean.confidence = answer.confidence;
    answers[id] = clean;
  }
  return answers;
}

async function saveCache(key, result) {
  const write = cacheWrites.then(async () => {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith("postlens:"));
    const obsolete = entries.filter(([k]) => !k.startsWith(CACHE_PREFIX)).map(([k]) => k);
    const current = entries.filter(([k]) => k.startsWith(CACHE_PREFIX) && k !== key)
      .sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0));
    await chrome.storage.local.remove([...obsolete, ...current.slice(MAX_CACHE_ENTRIES - 1).map(([k]) => k)]);
    await chrome.storage.local.set({ [key]: result });
  });
  cacheWrites = write.catch(() => {});
  return write;
}

async function requestJSON(endpoint, apiKey, payload, provider) {
  if (Date.now() < (provider === "OpenAI" ? openaiRetryAfter : retryAfter)) fail(`${provider} is busy or rate limited. Wait a minute, then retry.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  let body;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit", redirect: "error", signal: controller.signal
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) fail(`${provider} rejected the API key. Update it in PostLens settings.`);
      if ([429, 529].includes(response.status)) {
        const header = response.headers.get("Retry-After");
        const seconds = header === null ? NaN : Number(header);
        const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header);
        const next = Math.max(Date.now() + 60000, Number.isFinite(until) ? until : 0);
        if (provider === "OpenAI") openaiRetryAfter = next;
        else retryAfter = next;
        fail(`${provider} is busy or rate limited. Wait a minute, then retry.`);
      }
      fail(`${provider} request failed (HTTP ${response.status}). Try again later.`);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail(controller.signal.aborted ? `${provider} timed out. Retry when ready.` : `Could not reach ${provider} or read its response. Check your connection and retry.`);
  } finally {
    clearTimeout(timeout);
  }
  return body;
}

async function analyze(state, key) {
  const { jevApiKey } = await chrome.storage.local.get("jevApiKey");
  if (!jevApiKey) fail("Add your Jev API key in PostLens settings, then retry.");
  const body = await requestJSON(JEV_ENDPOINT, jevApiKey, { state, model: JEV_MODEL, questions: QUESTIONS }, "Jev");
  const result = { answers: normalizeAnswers(body), savedAt: Date.now() };
  try {
    await saveCache(key, result);
  } catch {
    return { ...result, cacheWarning: "Result could not be saved locally. Revisiting may require another analysis." };
  }
  return result;
}

async function guidanceSettings() {
  const { timelineSettings } = await chrome.storage.local.get("timelineSettings");
  return { goal: bounded(timelineSettings?.goal, 1000), enabled: timelineSettings?.enabled === true };
}

async function adviceKey(state, settings) {
  // Goal/model/text changes cannot reuse advice for a different objective or post edit.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    GUIDANCE_VERSION, OPENAI_MODEL, settings.goal, state.post, state.author || {}
  ])));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return `${await cacheKey(state)}:advice:${hash}`;
}

async function buildAdvice(state, base, settings, key) {
  const { openaiApiKey } = await chrome.storage.local.get("openaiApiKey");
  const { jevApiKey } = await chrome.storage.local.get("jevApiKey");
  if (!openaiApiKey) fail("Add your OpenAI API key in PostLens settings to get timeline advice.");
  if (!jevApiKey) fail("Add your Jev API key in PostLens settings to get timeline advice.");
  const response = await requestJSON(OPENAI_ENDPOINT, openaiApiKey, contextRequest(state, settings.goal), "OpenAI");
  let context;
  try {
    context = parseContext(response);
    // No credential ever appears in prompts; also reject unexpected echoed secrets.
    if ([openaiApiKey, jevApiKey].some(secret => JSON.stringify(context).includes(secret))) throw Error("Secret echo");
  } catch { fail("OpenAI could not produce usable context. Your original Jev scores are still available; retry advice when ready."); }
  const body = await requestJSON(JEV_ENDPOINT, jevApiKey, {
    model: JEV_MODEL, questions: GOAL_QUESTIONS,
    state: {
      ...state, timeline_goal: settings.goal, post_analysis: base.answers,
      model_interpretation: { provenance: "OpenAI interpretation of visible text only; unverified, not independent evidence", ...context }
    }
  }, "Jev");
  let advice;
  try { advice = normalizeAdvice(body, context); }
  catch { fail("Jev returned invalid timeline advice. Your original scores are still available; retry advice when ready."); }
  try { await saveCache(key, { advice, savedAt: Date.now() }); }
  catch { return { ...advice, cacheWarning: "Timeline advice could not be saved locally." }; }
  return advice;
}

async function attachAdvice(state, base, readOnly) {
  const settings = await guidanceSettings();
  if (!settings.enabled || !settings.goal) return base;
  const key = await adviceKey(state, settings);
  const entry = (await chrome.storage.local.get(key))[key];
  if (entry?.advice) {
    try { return { ...base, adviceAvailable: true, advice: validateAdvice(entry.advice) }; }
    catch { await chrome.storage.local.remove(key); }
  }
  if (readOnly) return { ...base, adviceAvailable: true };
  try {
    if (!pending.has(key)) pending.set(key, buildAdvice(state, base, settings, key).finally(() => pending.delete(key)));
    const advice = await pending.get(key);
    // Settings can change while a request is in flight. Never show the old goal's advice.
    const latest = await guidanceSettings();
    if (!latest.enabled || latest.goal !== settings.goal) return { ...base, adviceError: "Your timeline goal changed. Refresh this tab for current advice." };
    return { ...base, adviceAvailable: true, advice };
  } catch (error) {
    return { ...base, adviceAvailable: true, adviceError: error instanceof UserError ? error.message : "Timeline advice is unavailable. Your original Jev scores are still available." };
  }
}

function isPostSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  try { return ["https://x.com", "https://www.x.com"].includes(new URL(sender.url).origin); }
  catch { return false; }
}

export async function handleMessage(message, sender) {
  await storageReady;
  const optionsSender = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("options.html");
  if (optionsSender) {
    if (message?.type === "SETTINGS_STATUS") {
      const data = await chrome.storage.local.get("jevApiKey");
      const openai = await chrome.storage.local.get("openaiApiKey");
      return { ok: true, hasKey: Boolean(data.jevApiKey), hasOpenAIKey: Boolean(openai.openaiApiKey), timeline: await guidanceSettings() };
    }
    if (message?.type === "SAVE_KEY") {
      const key = bounded(message.key, 4096);
      if (!key || /\s/.test(key)) fail("Enter a valid API key without whitespace.");
      if (message.provider && !["jev", "openai"].includes(message.provider)) fail("Unknown key provider.");
      await chrome.storage.local.set({ [message.provider === "openai" ? "openaiApiKey" : "jevApiKey"]: key });
      return { ok: true };
    }
    if (message?.type === "REMOVE_KEY") {
      if (message.provider && !["jev", "openai"].includes(message.provider)) fail("Unknown key provider.");
      await chrome.storage.local.remove(message.provider === "openai" ? "openaiApiKey" : "jevApiKey");
      return { ok: true };
    }
    if (message?.type === "SAVE_TIMELINE") {
      if (typeof message.goal !== "string" || message.goal.length > 1000 || typeof message.enabled !== "boolean") fail("Enter a timeline goal of at most 1,000 characters.");
      const goal = message.goal.trim();
      if (message.enabled && !goal) fail("Enter a timeline goal before enabling advice.");
      await chrome.storage.local.set({ timelineSettings: { goal, enabled: message.enabled } });
      return { ok: true };
    }
    if (message?.type === "CLEAR_CACHE") {
      await cacheWrites;
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith("postlens:")));
      return { ok: true };
    }
  }
  if (!isPostSender(sender)) fail("This request is not allowed.");
  if (message?.type === "OPEN_OPTIONS") {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (!["GET_CACHED", "ANALYZE"].includes(message?.type)) fail("Unknown request.");
  const state = cleanState(message.state);
  const key = await cacheKey(state);
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached?.answers) {
    let result;
    try { result = { answers: normalizeAnswers(cached), savedAt: cached.savedAt }; }
    catch { await chrome.storage.local.remove(key); }
    if (result) return { ok: true, result: await attachAdvice(state, result, message.type === "GET_CACHED"), cached: true };
  }
  if (message.type === "GET_CACHED") return { ok: true, result: null };
  if (!pending.has(key)) {
    const task = analyze(state, key).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return { ok: true, result: await attachAdvice(state, await pending.get(key), false), cached: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, error => sendResponse({
    ok: false, error: error instanceof UserError ? error.message : "PostLens could not access local storage. Reload the extension and retry."
  }));
  return true;
});
chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage().catch(() => {}); });
