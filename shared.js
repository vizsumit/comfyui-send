// Shared by the background worker, the popup and the settings page.
const TEXT_TITLE = "INPUT_TEXT";
const IMAGE_TITLE = "INPUT_IMAGE";
const DEFAULT_BASE = "http://127.0.0.1:8188";
const ORIGIN_RULE_ID = 1;
const HELP_URL = "https://github.com/vizsumit/comfyui-send#readme";

function findNodes(wf, title) {
  return Object.values(wf).filter(n => n && n._meta && n._meta.title === title);
}

// Checks an imported file. Returns { error } or { text, image } (node objects or null).
function inspectWorkflow(parsed) {
  if (!parsed || typeof parsed !== "object") return { error: "That file is not a workflow." };
  if (Array.isArray(parsed.nodes)) {
    return { error: "This is the regular workflow format. In ComfyUI, use Workflow > Export (API) and import that file instead." };
  }
  const nodes = Object.values(parsed);
  if (!nodes.length || !nodes.every(n => n && typeof n === "object" && n.class_type)) {
    return { error: "This doesn't look like an API-format workflow. In ComfyUI, use Workflow > Export (API)." };
  }
  const t = findNodes(parsed, TEXT_TITLE);
  const i = findNodes(parsed, IMAGE_TITLE);
  if (t.length > 1) return { error: `Found ${t.length} nodes titled ${TEXT_TITLE}. Use only one.` };
  if (i.length > 1) return { error: `Found ${i.length} nodes titled ${IMAGE_TITLE}. Use only one.` };
  if (!t.length && !i.length) {
    return { error: `No node is titled ${TEXT_TITLE} or ${IMAGE_TITLE}. Rename the node that should receive your input in ComfyUI (double-click its title), then export again.` };
  }
  return { text: t[0] || null, image: i[0] || null };
}

// ---------- Storage ----------
// workflows: { [name]: { workflow } }   activeId: name of the workflow in use

// Version 1.0 kept a single workflow. Move it into the new list.
async function migrateLegacy() {
  const s = await chrome.storage.local.get(["workflow", "workflowName", "workflows", "activeId"]);
  if (!s.workflow) return;
  const workflows = s.workflows || {};
  const name = (s.workflowName || "workflow").replace(/\.json$/i, "");
  if (!workflows[name]) workflows[name] = { workflow: s.workflow };
  await chrome.storage.local.set({ workflows, activeId: s.activeId || name });
  await chrome.storage.local.remove(["workflow", "workflowName"]);
}

async function loadState() {
  await migrateLegacy();
  const s = await chrome.storage.local.get({ workflows: {}, activeId: null, baseUrl: DEFAULT_BASE, randomizeSeed: true });
  if (!s.workflows[s.activeId]) s.activeId = Object.keys(s.workflows)[0] || null;
  return s;
}

// ComfyUI rejects requests whose Origin header doesn't match its own address.
// Requests that come from this extension get their Origin header removed, so no CORS flag is needed.
async function syncOriginRule(baseUrl) {
  const origin = new URL(baseUrl).origin;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules: [{
      id: ORIGIN_RULE_ID,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
      condition: {
        urlFilter: `|${origin}/`,
        resourceTypes: ["xmlhttprequest"],
        initiatorDomains: [chrome.runtime.id]
      }
    }]
  });
}

function explainNetworkError(base, status) {
  if (status === 403) {
    return `ComfyUI refused the request (HTTP 403). It blocks requests from other origins. ` +
      `Restart ComfyUI once with:  --enable-cors-header "chrome-extension://${chrome.runtime.id}"`;
  }
  if (status) return `ComfyUI answered HTTP ${status}. Check the ComfyUI terminal for details.`;
  return `Could not reach ComfyUI at ${base}. Is it running, and is the address right?`;
}
