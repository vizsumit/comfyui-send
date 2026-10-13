importScripts("shared.js");

// ---------- Menus ----------
let menuChain = Promise.resolve();
function rebuildMenus() {
  menuChain = menuChain.then(buildMenus).catch(console.error);
}

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const s = await loadState();
  const active = s.activeId && s.workflows[s.activeId];
  if (!active) {
    chrome.contextMenus.create({ id: "setup", title: "ComfyUI Send: import a workflow first", contexts: ["selection", "image"] });
    return;
  }
  const short = s.activeId.length > 28 ? s.activeId.slice(0, 27) + "…" : s.activeId;
  if (findNodes(active.workflow, TEXT_TITLE).length) {
    chrome.contextMenus.create({ id: "send-text", title: `Send selection to ComfyUI (${short})`, contexts: ["selection"] });
  }
  if (findNodes(active.workflow, IMAGE_TITLE).length) {
    chrome.contextMenus.create({ id: "send-image", title: `Send image to ComfyUI (${short})`, contexts: ["image"] });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await loadState();
  rebuildMenus();
  syncOriginRule(s.baseUrl).catch(console.error);
  if (!Object.keys(s.workflows).length) chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.workflows || changes.activeId || changes.workflow) rebuildMenus();
  if (changes.baseUrl) syncOriginRule(changes.baseUrl.newValue || DEFAULT_BASE).catch(console.error);
});

// ---------- Workflow editing ----------
function setText(node, text) {
  const inp = node.inputs;
  const key = ["text", "value", "string", "prompt"].find(k => typeof inp[k] === "string")
    || Object.keys(inp).find(k => typeof inp[k] === "string");
  if (!key) throw new Error(`The ${TEXT_TITLE} node has no text field to fill.`);
  inp[key] = text;
}

function setImage(node, filename) {
  const inp = node.inputs;
  const key = "image" in inp ? "image" : Object.keys(inp).find(k => typeof inp[k] === "string");
  if (!key) throw new Error(`The ${IMAGE_TITLE} node has no image field to fill.`);
  inp[key] = filename;
}

function randomizeSeeds(wf) {
  for (const node of Object.values(wf)) {
    for (const k of ["seed", "noise_seed"]) {
      if (node.inputs && typeof node.inputs[k] === "number") {
        node.inputs[k] = Math.floor(Math.random() * 2 ** 50);
      }
    }
  }
}

// ---------- ComfyUI calls ----------
async function request(base, path, options) {
  let res;
  try {
    res = await fetch(base + path, options);
  } catch (e) {
    throw new Error(explainNetworkError(base, 0));
  }
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
  return { res, data };
}

async function uploadImage(srcUrl, base) {
  let blob;
  try {
    const r = await fetch(srcUrl, { credentials: "include" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    blob = await r.blob();
  } catch (e) {
    throw new Error("Could not download that image. Some sites block it, and in-page blob images can't be read.");
  }
  if (blob.type && !blob.type.startsWith("image/")) throw new Error("That link is not an image.");
  const ext = ((blob.type || "image/png").split("/")[1] || "png").split("+")[0].replace("jpeg", "jpg");
  const name = `send_${Date.now()}.${ext}`;
  const fd = new FormData();
  fd.append("image", blob, name);
  fd.append("type", "input");

  const { res, data } = await request(base, "/upload/image", { method: "POST", body: fd });
  if (!res.ok || !data || !data.name) throw new Error(explainNetworkError(base, res.status));
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function queuePrompt(wf, base) {
  const { res, data } = await request(base, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "comfyui-send" })
  });
  if (res.ok && data && data.prompt_id) return data.prompt_id;
  if (data && (data.error || data.node_errors)) {
    const lines = [data.error && data.error.message ? data.error.message : "ComfyUI rejected the workflow."];
    for (const [id, n] of Object.entries(data.node_errors || {})) {
      (n.errors || []).forEach(e => lines.push(`Node ${id} (${n.class_type}): ${e.message}`));
    }
    throw new Error(lines.join("\n"));
  }
  throw new Error(explainNetworkError(base, res.status));
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message: message.slice(0, 250) });
}

// ---------- Click handler ----------
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "setup") { chrome.runtime.openOptionsPage(); return; }
  try {
    const s = await loadState();
    const active = s.activeId && s.workflows[s.activeId];
    if (!active) throw new Error("No workflow imported yet. Open the extension settings.");
    const base = s.baseUrl.replace(/\/+$/, "");
    await syncOriginRule(base);

    const wf = structuredClone(active.workflow);
    if (info.menuItemId === "send-text") {
      const text = (info.selectionText || "").trim();
      if (!text) throw new Error("No text was selected.");
      setText(findNodes(wf, TEXT_TITLE)[0], text);
    } else if (info.menuItemId === "send-image") {
      const filename = await uploadImage(info.srcUrl, base);
      setImage(findNodes(wf, IMAGE_TITLE)[0], filename);
    } else {
      return;
    }
    if (s.randomizeSeed) randomizeSeeds(wf);
    await queuePrompt(wf, base);
    notify("Sent to ComfyUI", `Queued with "${s.activeId}". Check ComfyUI for the result.`);
  } catch (e) {
    notify("Could not send", e.message);
  }
});
