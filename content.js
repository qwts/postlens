(() => {
  "use strict";
  const TWEET = 'article[data-testid="tweet"]';
  const ROOT = ".postlens";
  const records = new WeakMap();
  const dirty = new Set();
  let scheduled = false;
  const labels = {
    sensationalism: "Hype", evidence_alignment: "Evidence", manipulation: "Manipulation",
    automation_signals: "Automation signals", certainty_language: "Certainty", account_context: "Account context"
  };

  function own(article, selector) {
    return [...article.querySelectorAll(selector)].filter(node =>
      node.closest(TWEET) === article && !node.closest(ROOT) &&
      !node.closest('[data-testid="quoteTweet"], [role="link"]')
    );
  }

  // Keep emoji alt text and line breaks; skip hidden UI. No image content is read.
  function visibleText(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    return [...node.childNodes].map(visibleText).join("") + (style.display === "block" ? "\n" : "");
  }

  function extract(article) {
    const textNode = own(article, '[data-testid="tweetText"]')[0];
    const post = visibleText(textNode).trim();
    const state = { post };
    const author = {};
    const name = own(article, '[data-testid="User-Name"]')[0];
    if (name) {
      const links = [...name.querySelectorAll('a[href]')];
      const profile = links.find(link => /^\/[A-Za-z0-9_]{1,15}$/.test(new URL(link.href, location.href).pathname));
      const display = visibleText(profile).trim();
      if (display) author.display_name = display;
      const handle = visibleText(name).match(/(?:^|\s)(@[A-Za-z0-9_]{1,15})(?=\s|$|·)/)?.[1];
      if (handle) author.handle = handle;
      else if (profile) author.handle = `@${new URL(profile.href, location.href).pathname.slice(1)}`;
      if (name.querySelector('[data-testid="icon-verified"]')) author.verified = true;
    }
    if (Object.keys(author).length) state.author = author;
    const metadata = {};
    // The timestamp permalink belongs to the outer post; arbitrary status links
    // can point at quoted posts, media, or references in the text.
    const time = own(article, "time")[0];
    const permalink = time?.closest('a[href]');
    const path = permalink ? new URL(permalink.href, location.href).pathname : "";
    const id = path.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)(?:\/|$)/)?.[1];
    if (id) metadata.tweet_id = id;
    const date = time?.getAttribute("datetime");
    if (date && Number.isFinite(Date.parse(date))) metadata.posted_at = date;
    const viewsLink = own(article, 'a[href$="/analytics"]').find(link =>
      id && new URL(link.href, location.href).pathname.includes(`/status/${id}/`));
    const views = visibleText(viewsLink).trim();
    if (views && views.length <= 40) metadata.views = views;
    if (Object.keys(metadata).length) state.post_metadata = metadata;
    return { state, textNode };
  }

  const identity = state => JSON.stringify([state.post_metadata?.tweet_id || "", state.author?.handle || "", state.author?.display_name || "", state.post]);
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: "PostLens disconnected. Refresh this X tab, then retry." }; }
  }
  function current(article, record) {
    return article.isConnected && records.get(article) === record && identity(extract(article).state) === record.identity;
  }

  function renderResult(record, result, cached) {
    const details = element("details", "postlens-result");
    details.open = true;
    details.append(element("summary", "", cached ? "JEV · saved analysis" : "JEV"));
    const list = element("dl", "postlens-scores");
    const row = (label, value, confidence) => {
      list.append(element("dt", "", label));
      const dd = element("dd", "", value);
      if (typeof confidence === "number") dd.append(element("small", "postlens-confidence", ` · ${Math.round(confidence * 100)}% confidence`));
      list.append(dd);
    };
    row("Factual claim", `${Math.round(result.answers.contains_factual_claim.noul * 100)}%`);
    for (const [id, label] of Object.entries(labels)) {
      const answer = result.answers[id];
      row(label, `${answer.score.toFixed(2)} / 4`, answer.confidence);
    }
    details.append(list);
    details.append(element("p", "postlens-type", `Type: ${result.answers.post_type.choice}`));
    details.append(element("p", "postlens-note", "Visible text only; no external fact-check. Automation signals do not prove an account is a bot. Account context uses limited visible metadata."));
    if (result.advice) {
      const advice = result.advice;
      const section = element("section", "postlens-advice");
      section.append(element("strong", "", "Your timeline goal"));
      section.append(element("p", "", `Goal fit: ${advice.alignment.toFixed(2)} / 4 · ${Math.round(advice.alignmentConfidence * 100)}% confidence`));
      const names = { skip: "Skip", like: "Consider liking", like_follow: "Consider like + follow", mute: "Consider mute", review: "Review before acting" };
      section.append(element("p", "postlens-suggestion", `Suggested: ${names[advice.action]} · ${Math.round(advice.actionConfidence * 100)}% Jev confidence`));
      section.append(element("p", "", advice.context.goal_relation));
      const context = element("details", "postlens-context");
      context.append(element("summary", "", "Why this may fit · GPT-5.6 Luna"));
      context.append(element("p", "", advice.context.summary));
      if (advice.context.topics.length) context.append(element("p", "", `Topics: ${advice.context.topics.join(", ")}`));
      context.append(element("p", "", `Potential value: ${advice.context.potential_value}`));
      context.append(element("p", "", `Potential downside: ${advice.context.potential_downside}`));
      if (advice.context.uncertainties.length) {
        const list = element("ul", "");
        for (const uncertainty of advice.context.uncertainties) list.append(element("li", "", uncertainty));
        context.append(list);
      }
      section.append(context);
      if (advice.cautionApplied) section.append(element("p", "postlens-note", "Low confidence or weak goal fit: review is shown instead of a stronger action."));
      const guidance = {
        skip: "No action needed. Keep scrolling.",
        like: "If you agree after reviewing the post, use X's Like button.",
        like_follow: "Review the author's other posts first. If they consistently help your goal, use X's Like and Follow controls.",
        mute: "Review the author's profile first. If you want to exclude the account, use X's post/profile menu → Mute. One post may not represent the account.",
        review: "Read the post, check its sources, and review the author's profile before deciding."
      };
      section.append(element("p", "", guidance[advice.action]));
      const handle = record.state.author?.handle;
      if (advice.action !== "skip" && /^@[A-Za-z0-9_]{1,15}$/.test(handle || "")) {
        const link = element("a", "postlens-profile", `Review ${handle} on X`);
        link.href = `https://x.com/${handle.slice(1)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        section.append(link);
      }
      section.append(element("p", "postlens-note", "AI interpretation of visible text, not independent evidence. You choose actions on X; ranking changes are not guaranteed."));
      if (advice.cacheWarning) section.append(element("p", "postlens-note", advice.cacheWarning));
      details.append(section);
    }
    if (result.adviceError) details.append(element("p", "postlens-note", result.adviceError));
    if (result.cacheWarning) details.append(element("p", "postlens-note", result.cacheWarning));
    record.output.replaceChildren(details);
    record.button.hidden = !result.adviceAvailable || Boolean(result.advice);
    if (!record.button.hidden) record.button.textContent = result.adviceError ? "Retry timeline advice" : "Analyze for my goal";
  }

  function enhance(article) {
    const { state, textNode } = extract(article);
    const signature = identity(state);
    const previous = records.get(article);
    if (previous?.identity === signature && article.contains(previous.root)) return;
    if (previous) previous.root.remove();
    // Clean markers cloned by the SPA, without touching a nested tweet's UI.
    article.querySelectorAll(ROOT).forEach(node => { if (node.closest(TWEET) === article) node.remove(); });
    const root = element("div", "postlens");
    root.dataset.postlens = "enhanced";
    const toolbar = element("div", "postlens-toolbar");
    const button = element("button", "postlens-button", "JEV Analyze");
    button.type = "button";
    button.title = "Send this post’s visible text and metadata to Jev";
    const settings = element("button", "postlens-settings", "Settings");
    settings.type = "button";
    const output = element("div", "postlens-output");
    output.setAttribute("aria-live", "polite");
    toolbar.append(button, settings);
    root.append(toolbar, output);
    // Prevent clicks/keyboard events from activating the surrounding tweet.
    for (const event of ["click", "keydown", "pointerdown"]) root.addEventListener(event, e => e.stopPropagation());
    const actions = own(article, '[role="group"]').find(node => node.querySelector('[data-testid="reply"]'));
    const mount = actions?.parentElement || textNode?.parentElement || article.lastElementChild || article;
    mount.append(root);
    const record = { identity: signature, state, root, button, output, busy: false, started: false };
    records.set(article, record);
    settings.addEventListener("click", async () => {
      const reply = await send({ type: "OPEN_OPTIONS" });
      if (!reply?.ok && current(article, record)) output.textContent = reply?.error || "Could not open settings.";
    });
    if (!state.post) {
      button.disabled = true;
      button.title = "No visible text. Images and video are not analyzed in V1.";
      return;
    }
    button.addEventListener("click", async event => {
      if (!event.isTrusted || record.busy) return;
      if (!current(article, record)) { enhance(article); return; }
      record.busy = true;
      record.started = true;
      button.disabled = true;
      button.textContent = "JEV Analyzing…";
      root.setAttribute("aria-busy", "true");
      output.replaceChildren();
      const reply = await send({ type: "ANALYZE", state: extract(article).state });
      if (!current(article, record)) return;
      record.busy = false;
      button.disabled = false;
      root.removeAttribute("aria-busy");
      if (reply?.ok && reply.result) renderResult(record, reply.result, reply.cached);
      else {
        button.textContent = "JEV Retry";
        output.textContent = reply?.error || "Analysis failed. Please retry.";
      }
    });
    // Cache reads never call Jev, and do not require credentials.
    send({ type: "GET_CACHED", state }).then(reply => {
      if (current(article, record) && !record.started && !record.busy && !button.hidden && reply?.ok && reply.result) renderResult(record, reply.result, true);
    });
  }

  function queue(article) {
    dirty.add(article);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const node of dirty) if (node.isConnected) enhance(node);
      dirty.clear();
    });
  }
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (target?.closest(ROOT)) continue;
      const article = target?.closest(TWEET);
      if (article) queue(article);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || node.matches(ROOT)) continue;
        if (node.matches(TWEET)) queue(node);
        node.querySelectorAll(TWEET).forEach(queue);
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "datetime", "data-testid"] });
  document.querySelectorAll(TWEET).forEach(queue);
})();
