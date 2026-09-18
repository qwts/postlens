"use strict";
const form = document.querySelector("#settings");
const keyInput = document.querySelector("#api-key");
const status = document.querySelector("#status");
const keyStatus = document.querySelector("#key-status");

async function request(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || "Could not save settings.");
  return reply;
}
async function refresh() {
  const reply = await request({ type: "SETTINGS_STATUS" });
  keyStatus.textContent = reply.hasKey ? "A key is saved. Enter a new key to replace it." : "No key saved yet.";
}
async function act(action, success) {
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  try {
    await action();
    await refresh();
    status.textContent = success;
  } catch {
    status.textContent = "Could not update settings. Check the key, or reload the extension and try again.";
  } finally {
    keyInput.value = "";
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
refresh().catch(() => { keyStatus.textContent = "Could not read settings. Reload the extension."; });
