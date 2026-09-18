import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { QUESTIONS } from "../../questions.js";

const interpretation = {
  summary: "The post claims a chip has 12 cores.", topics: ["hardware"],
  goal_relation: "This hardware detail relates to learning practical engineering.",
  potential_value: "A concrete claim to investigate.", potential_downside: "No source. <img src=x onerror=alert(1)>",
  uncertainties: ["The author's other posts are unknown."]
};

const response = { model: "jev-1.13.0", usage: { input_tokens: 312, output_tokens: 48 }, answers: Object.fromEntries(
  Object.entries(QUESTIONS).map(([id, q]) => [id, q.type === "noul" ? { type: "noul", noul: 0.98 } : q.type === "choice" ?
    { type: "choice", choice: "technical_reporting", confidence: 0.9 } : { type: "score", score: 2.14, confidence: 0.8 }])
) };

const tweet = (id, text = "This chip has 12 cores.") => `<article data-testid="tweet" id="tweet-${id}"><div>
  <div data-testid="User-Name"><a href="/alice"><span>Alice</span></a><a href="/alice"><span>@alice</span></a>
  <svg data-testid="icon-verified"></svg><a href="/alice/status/${id}"><time datetime="2026-09-17T10:00:00Z">2h</time></a></div>
  <div data-testid="tweetText">${text}<span hidden>HIDDEN</span><img alt="🚀"></div>
  <div role="link"><div data-testid="User-Name">Quoted Bob</div><a href="/bob/status/999"><time>yesterday</time></a><div data-testid="tweetText">Quoted text must not become the original post.</div></div>
  <div role="group"><button data-testid="reply">Reply</button><button data-testid="like">Like</button><a href="/alice/status/${id}/analytics">1.2K</a></div>
</div></article>`;

test("real MV3 extension: settings, extraction, clicks, cache, SPA recycling and errors", { timeout: 90000 }, async () => {
  const root = resolve(".");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    executablePath: process.env.POSTLENS_TEST_CHROMIUM || undefined,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    // Fake only the external service. The extension, Chrome messaging/storage,
    // isolated content script, trusted clicks, and Options page are real.
    await worker.evaluate(({ body, interpretation }) => {
      globalThis.testRequests = [];
      globalThis.testStatus = 200;
      globalThis.testDelay = 0;
      globalThis.openaiStatus = 200;
      globalThis.fetch = async (url, init) => {
        const request = JSON.parse(init.body);
        globalThis.testRequests.push({ url, body: request, authorization: init.headers.Authorization });
        await new Promise(resolve => setTimeout(resolve, globalThis.testDelay));
        if (url.includes("openai.com")) return new Response(JSON.stringify({ status: "completed", output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(interpretation) }] }
        ] }), { status: globalThis.openaiStatus });
        if (request.questions.goal_alignment) return new Response(JSON.stringify({ answers: {
          goal_alignment: { type: "score", score: 3.8, confidence: 0.9 },
          suggested_action: { type: "choice", choice: "like_follow", confidence: 0.91 }
        } }));
        return new Response(globalThis.testStatus === 200 ? JSON.stringify(body) : "never expose response body", { status: globalThis.testStatus });
      };
    }, { body: response, interpretation });
    await context.route("https://x.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><style>body{font:15px Arial;max-width:600px;margin:auto}article{padding:16px;border-bottom:1px solid #aaa}a{margin-right:8px}</style></head><body>${tweet("123")}</body></html>` }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("https://x.com/home");
    await page.locator(".postlens-button").waitFor();
    assert.equal(await page.locator(".postlens").count(), 1);
    assert.equal(await worker.evaluate(() => testRequests.length), 0);
    // Synthetic page clicks cannot spend API credits.
    await page.locator(".postlens-button").evaluate(button => button.click());
    assert.equal(await worker.evaluate(() => testRequests.length), 0);
    await page.locator(".postlens-button").click();
    await page.getByText("Add your Jev API key", { exact: false }).waitFor();

    const options = await context.newPage();
    await options.goto(`chrome-extension://${worker.url().split("/")[2]}/options.html`);
    await options.locator("#api-key").fill("test-only-secret");
    await options.getByRole("button", { name: "Save key", exact: true }).click();
    await options.locator("#status").filter({ hasText: "Key saved." }).waitFor();
    assert.equal(await options.locator("#api-key").inputValue(), "");
    await page.locator(".postlens-button").click();
    await page.locator(".postlens-result").waitFor();
    assert.match(await page.locator(".postlens-result").innerText(), /98%/);
    assert.match(await page.locator(".postlens-result").innerText(), /80% confidence/);
    assert.ok(!(await page.content()).includes("test-only-secret"));
    const requests = await worker.evaluate(() => testRequests);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer test-only-secret");
    assert.deepEqual(requests[0].body.state, {
      post: "This chip has 12 cores.🚀", author: { display_name: "Alice", handle: "@alice", verified: true },
      post_metadata: { tweet_id: "123", posted_at: "2026-09-17T10:00:00Z", views: "1.2K" }
    });
    assert.deepEqual(requests[0].body.questions, QUESTIONS);

    // Remount restores cached results without a fresh click or network request.
    const cdp = await context.newCDPSession(page);
    const worlds = [];
    cdp.on("Runtime.executionContextCreated", event => worlds.push(event.context));
    await cdp.send("Runtime.enable");
    await page.reload();
    await page.getByText("JEV · saved analysis", { exact: true }).waitFor();
    assert.equal(await worker.evaluate(() => testRequests.length), 1);
    // Check Chrome's real access control in the isolated content-script world.
    let checkedStorageBoundary = false;
    for (const world of worlds.filter(world => world.auxData?.type === "isolated")) {
      try {
        const result = await cdp.send("Runtime.evaluate", {
          contextId: world.id, awaitPromise: true, returnByValue: true,
          expression: `(async () => {
            if (typeof chrome === "undefined" || !chrome.runtime?.id) return "unrelated";
            try { await chrome.storage.local.get(["jevApiKey", "openaiApiKey"]); return "readable"; }
            catch { return "blocked"; }
          })()`
        });
        if (result.result.value === "unrelated") continue;
        assert.equal(result.result.value, "blocked");
        checkedStorageBoundary = true;
      } catch (error) {
        if (error.message.includes("Cannot find context")) continue;
        throw error;
      }
    }
    assert.equal(checkedStorageBoundary, true);
    // Reuse the same article element for a different post.
    await page.locator("article").evaluate((article, html) => {
      const template = document.createElement("template"); template.innerHTML = html;
      article.innerHTML = template.content.firstElementChild.innerHTML;
    }, tweet("456", "A different post."));
    await page.locator(".postlens-button:not([hidden])").waitFor();
    assert.equal(await page.locator(".postlens").count(), 1);
    assert.equal(await page.locator(".postlens-result").count(), 0);
    await worker.evaluate(() => { globalThis.testStatus = 500; });
    await page.locator(".postlens-button").click();
    await page.getByText("Jev request failed (HTTP 500). Try again later.", { exact: true }).waitFor();
    assert.ok(!(await page.content()).includes("never expose response body"));
    await worker.evaluate(() => { globalThis.testStatus = 200; });
    await page.getByRole("button", { name: "JEV Retry" }).click();
    await page.locator(".postlens-result").waitFor();

    // Late result for an old article must not attach to its replacement.
    await page.evaluate(html => { document.body.innerHTML = html; }, tweet("700"));
    await page.locator(".postlens-button").waitFor();
    await worker.evaluate(() => { globalThis.testDelay = 200; });
    await page.locator(".postlens-button").click();
    await page.getByRole("button", { name: "JEV Analyzing…" }).waitFor();
    await page.locator("article").evaluate((article, html) => {
      const template = document.createElement("template"); template.innerHTML = html;
      article.innerHTML = template.content.firstElementChild.innerHTML;
    }, tweet("701"));
    await page.getByRole("button", { name: "JEV Analyze", exact: true }).waitFor();
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".postlens-result").count(), 0);
    assert.equal(await page.locator(".postlens").count(), 1);

    // Enable optional enrichment via the real Options page. Cache lookups must
    // still avoid spending, and suggestions must never click native X controls.
    await worker.evaluate(() => { globalThis.testDelay = 0; });
    await options.locator("#openai-key").fill("openai-test-secret");
    await options.getByRole("button", { name: "Save OpenAI key", exact: true }).click();
    await options.getByText("OpenAI key saved.", { exact: true }).waitFor();
    assert.equal(await options.locator("#openai-key").inputValue(), "");
    await options.locator("#timeline-goal").fill("Learn practical hardware engineering");
    await options.locator("#timeline-enabled").check();
    await options.getByRole("button", { name: "Save timeline goal" }).click();
    await options.getByText("Timeline goal saved.", { exact: false }).waitFor();
    const before = await worker.evaluate(() => testRequests.length);
    await page.reload();
    await page.getByRole("button", { name: "Analyze for my goal" }).waitFor();
    assert.equal(await worker.evaluate(() => testRequests.length), before);
    await page.evaluate(() => {
      window.nativeActions = 0;
      document.querySelector('[data-testid="like"]').addEventListener("click", () => window.nativeActions++);
    });
    await page.getByRole("button", { name: "Analyze for my goal" }).click();
    await page.locator(".postlens-advice").waitFor();
    assert.match(await page.locator(".postlens-suggestion").innerText(), /Consider like \+ follow/);
    assert.equal(await page.locator(".postlens-profile").getAttribute("href"), "https://x.com/alice");
    assert.equal(await page.locator(".postlens-advice img").count(), 0);
    assert.equal(await page.evaluate(() => window.nativeActions), 0);
    assert.equal(await worker.evaluate(() => testRequests.length), before + 2);
    assert.ok(!(await page.content()).includes("openai-test-secret"));
    await page.reload();
    await page.locator(".postlens-advice").waitFor();
    assert.equal(await worker.evaluate(() => testRequests.length), before + 2);
    await options.locator("#timeline-goal").fill("See thoughtful criticism of hardware claims");
    await options.getByRole("button", { name: "Save timeline goal" }).click();
    await options.getByText("Timeline goal saved.", { exact: false }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Analyze for my goal" }).waitFor();
    assert.equal(await page.locator(".postlens-advice").count(), 0);
    await worker.evaluate(() => { globalThis.openaiStatus = 401; });
    await page.getByRole("button", { name: "Analyze for my goal" }).click();
    await page.getByRole("button", { name: "Retry timeline advice" }).waitFor();
    assert.match(await page.locator(".postlens-result").innerText(), /98%/);
    assert.match(await page.locator(".postlens-result").innerText(), /OpenAI rejected/);
    await worker.evaluate(() => { globalThis.openaiStatus = 200; });
    await page.getByRole("button", { name: "Retry timeline advice" }).click();
    await page.locator(".postlens-advice").waitFor();
    await options.locator("#timeline-enabled").uncheck();
    await options.getByRole("button", { name: "Save timeline goal" }).click();
    await options.getByText("Timeline goal saved.", { exact: false }).waitFor();
    await page.reload();
    await page.locator(".postlens-result").waitFor();
    assert.equal(await page.locator(".postlens-advice").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
