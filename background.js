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
    chrome.contextMenus.create({
      id: "setup",
      title: "ComfyUI Send: import a workflow first",
      contexts: ["selection", "image"],
    });
    return;
  }
  const short =
    s.activeId.length > 28 ? s.activeId.slice(0, 27) + "…" : s.activeId;
  if (findNodes(active.workflow, TEXT_TITLE).length) {
    chrome.contextMenus.create({
      id: "send-text",
      title: `Send selection to ComfyUI (${short})`,
      contexts: ["selection"],
    });
  }
  if (findNodes(active.workflow, IMAGE_TITLE).length) {
    chrome.contextMenus.create({
      id: "send-image",
      title: `Send image to ComfyUI (${short})`,
      contexts: ["image"],
    });
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
  if (changes.baseUrl)
    syncOriginRule(changes.baseUrl.newValue || DEFAULT_BASE).catch(
      console.error,
    );
});

// ---------- Workflow editing ----------
function setText(node, text) {
  const inp = node.inputs;
  const key =
    ["text", "value", "string", "prompt"].find(
      (k) => typeof inp[k] === "string",
    ) || Object.keys(inp).find((k) => typeof inp[k] === "string");
  if (!key)
    throw new Error(`The ${TEXT_TITLE} node has no text field to fill.`);
  inp[key] = text;
}

function setImage(node, filename) {
  const inp = node.inputs;
  const key =
    "image" in inp
      ? "image"
      : Object.keys(inp).find((k) => typeof inp[k] === "string");
  if (!key)
    throw new Error(`The ${IMAGE_TITLE} node has no image field to fill.`);
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
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {}
  return { res, data };
}

// X/Twitter serves a small version by default; ask for the original and fall back if that fails.
function imageCandidates(srcUrl) {
  try {
    const u = new URL(srcUrl);
    if (
      u.hostname === "pbs.twimg.com" &&
      u.pathname.startsWith("/media/") &&
      u.searchParams.has("name")
    ) {
      u.searchParams.set("name", "orig");
      return [u.href, srcUrl];
    }
  } catch (e) {}
  return [srcUrl];
}

async function downloadImage(srcUrl) {
  for (const url of imageCandidates(srcUrl)) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (r.ok) return await r.blob();
    } catch (e) {}
  }
  throw new Error("Could not download that image. Some sites block it.");
}

async function uploadImage(srcUrl, base) {
  const blob = await downloadImage(srcUrl);
  if (blob.type && !blob.type.startsWith("image/"))
    throw new Error("That link is not an image.");
  const ext = ((blob.type || "image/png").split("/")[1] || "png")
    .split("+")[0]
    .replace("jpeg", "jpg");
  const name = `send_${Date.now()}.${ext}`;
  const fd = new FormData();
  fd.append("image", blob, name);
  fd.append("type", "input");

  const { res, data } = await request(base, "/upload/image", {
    method: "POST",
    body: fd,
  });
  if (!res.ok || !data || !data.name)
    throw new Error(explainNetworkError(base, res.status));
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function queuePrompt(wf, base) {
  const { res, data } = await request(base, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "comfyui-send" }),
  });
  if (res.ok && data && data.prompt_id) return data.prompt_id;
  if (data && (data.error || data.node_errors)) {
    const lines = [
      data.error && data.error.message
        ? data.error.message
        : "ComfyUI rejected the workflow.",
    ];
    for (const [id, n] of Object.entries(data.node_errors || {})) {
      (n.errors || []).forEach((e) =>
        lines.push(`Node ${id} (${n.class_type}): ${e.message}`),
      );
    }
    throw new Error(lines.join("\n"));
  }
  throw new Error(explainNetworkError(base, res.status));
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: message.slice(0, 250),
  });
}

// ---------- Sending (shared by the right-click menu and the image button) ----------
async function prepare(kind) {
  const s = await loadState();
  const active = s.activeId && s.workflows[s.activeId];
  if (!active)
    throw new Error("No workflow imported yet. Open the extension settings.");
  const title = kind === "image" ? IMAGE_TITLE : TEXT_TITLE;
  if (!findNodes(active.workflow, title).length) {
    throw new Error(
      `The current workflow ("${s.activeId}") does not accept ${kind === "image" ? "images" : "text"}.`,
    );
  }
  const base = s.baseUrl.replace(/\/+$/, "");
  await syncOriginRule(base);
  return { s, wf: structuredClone(active.workflow), base };
}

async function sendText(text) {
  const t = (text || "").trim();
  if (!t) throw new Error("No text was selected.");
  const { s, wf, base } = await prepare("text");
  setText(findNodes(wf, TEXT_TITLE)[0], t);
  if (s.randomizeSeed) randomizeSeeds(wf);
  await queuePrompt(wf, base);
  return s.activeId;
}

async function sendImage(srcUrl) {
  const { s, wf, base } = await prepare("image");
  const filename = await uploadImage(srcUrl, base);
  setImage(findNodes(wf, IMAGE_TITLE)[0], filename);
  if (s.randomizeSeed) randomizeSeeds(wf);
  await queuePrompt(wf, base);
  return s.activeId;
}

// Right-click menu
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "setup") {
    chrome.runtime.openOptionsPage();
    return;
  }
  try {
    let name;
    if (info.menuItemId === "send-text")
      name = await sendText(info.selectionText);
    else if (info.menuItemId === "send-image")
      name = await sendImage(info.srcUrl);
    else return;
    notify(
      "Sent to ComfyUI",
      `Queued with "${name}". Check ComfyUI for the result.`,
    );
  } catch (e) {
    notify("Could not send", e.message);
  }
});

// One-click button on images (content.js)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== "send-image")
    return;
  sendImage(msg.url)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      notify("Could not send", e.message);
      sendResponse({ ok: false, error: e.message });
    });
  return true; // answer asynchronously
});
