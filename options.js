"use strict";
const form = document.querySelector("#settings");
const keyInput = document.querySelector("#api-key");
const status = document.querySelector("#status");
const keyStatus = document.querySelector("#key-status");
const openaiInput = document.querySelector("#openai-key");
const goalInput = document.querySelector("#timeline-goal");
const goalEnabled = document.querySelector("#timeline-enabled");

async function request(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || "Could not save settings.");
  return reply;
}
async function refresh(loadGoal = false) {
  const reply = await request({ type: "SETTINGS_STATUS" });
  keyStatus.textContent = reply.hasKey ? "A key is saved. Enter a new key to replace it." : "No key saved yet.";
  document.querySelector("#openai-key-status").textContent = reply.hasOpenAIKey ? "An OpenAI key is saved. Enter a new key to replace it." : "No OpenAI key saved. Original Jev analysis still works.";
  if (loadGoal) {
    goalInput.value = reply.timeline.goal;
    goalEnabled.checked = reply.timeline.enabled;
  }
}
async function act(action, success) {
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  try {
    await action();
    await refresh();
    status.textContent = success;
  } catch (error) {
    status.textContent = error.message || "Could not update settings. Reload the extension and try again.";
  } finally {
    keyInput.value = "";
    openaiInput.value = "";
    document.querySelectorAll("button").forEach(button => { button.disabled = false; });
  }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  const key = keyInput.value.trim();
  keyInput.value = "";
  void act(() => request({ type: "SAVE_KEY", key }), "Key saved. You can now analyze posts on X.");
});
document.querySelector("#remove-key").addEventListener("click", () => {
  void act(() => request({ type: "REMOVE_KEY" }), "Key removed.");
});
document.querySelector("#clear-cache").addEventListener("click", () => {
  void act(() => request({ type: "CLEAR_CACHE" }), "Saved analyses cleared. Refresh X to remove displayed results.");
});
document.querySelector("#openai-settings").addEventListener("submit", event => {
  event.preventDefault();
  const key = openaiInput.value.trim();
  openaiInput.value = "";
  void act(() => request({ type: "SAVE_KEY", provider: "openai", key }), "OpenAI key saved.");
});
document.querySelector("#remove-openai-key").addEventListener("click", () => {
  void act(() => request({ type: "REMOVE_KEY", provider: "openai" }), "OpenAI key removed.");
});
document.querySelector("#timeline-settings").addEventListener("submit", event => {
  event.preventDefault();
  const goal = goalInput.value.trim();
  const enabled = goalEnabled.checked;
  void act(() => request({ type: "SAVE_TIMELINE", goal, enabled }), "Timeline goal saved. Refresh X to use the new settings.");
});
refresh(true).catch(() => { keyStatus.textContent = "Could not read settings. Reload the extension."; });
