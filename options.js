const $ = id => document.getElementById(id);
$("help").href = HELP_URL;

function kindsOf(info) {
  if (info.error) return info.error;
  const k = [];
  if (info.text) k.push("text");
  if (info.image) k.push("image");
  return "Accepts " + k.join(" and ");
}

async function render() {
  const s = await loadState();
  $("base").value = s.baseUrl;
  $("rand").checked = s.randomizeSeed;
  $("btn").checked = s.showImageButton;

  const list = $("list");
  list.textContent = "";
  const ids = Object.keys(s.workflows);
  if (!ids.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No workflows yet. Import an API-format file below.";
    list.appendChild(p);
    return;
  }
  ids.forEach(id => {
    const info = inspectWorkflow(s.workflows[id].workflow);
    const row = document.createElement("div");
    row.className = "item" + (info.error ? " bad" : "");

    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "active"; radio.checked = id === s.activeId;
    radio.style.display = "none";
    const name = document.createElement("b");
    name.textContent = (id === s.activeId ? "● " : "○ ") + id;
    const kinds = document.createElement("span");
    kinds.className = "kinds";
    kinds.textContent = kindsOf(info);
    label.append(radio, name, kinds);
    label.addEventListener("click", async (e) => {
      e.preventDefault();
      await chrome.storage.local.set({ activeId: id });
      render();
    });

    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.addEventListener("click", async () => {
      if (!confirm(`Remove "${id}"?`)) return;
      const cur = await loadState();
      delete cur.workflows[id];
      const next = cur.activeId === id ? (Object.keys(cur.workflows)[0] || null) : cur.activeId;
      await chrome.storage.local.set({ workflows: cur.workflows, activeId: next });
      render();
    });

    row.append(label, rm);
    list.appendChild(row);
  });
}

$("file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const msg = $("importMsg");
  const done = [], problems = [];
  const s = await loadState();
  const workflows = s.workflows;

  for (const file of files) {
    const name = file.name.replace(/\.json$/i, "");
    try {
      const parsed = JSON.parse(await file.text());
      const info = inspectWorkflow(parsed);
      if (info.error) throw new Error(info.error);
      done.push(workflows[name] ? `${name} (replaced)` : name);
      workflows[name] = { workflow: parsed };
    } catch (err) {
      problems.push(`${file.name}: ${err instanceof SyntaxError ? "not valid JSON." : err.message}`);
    }
  }

  if (done.length) {
    const activeId = s.activeId || done[0].replace(/ \(replaced\)$/, "");
    await chrome.storage.local.set({ workflows, activeId });
  }
  msg.className = problems.length ? "msg err" : "msg ok";
  msg.textContent = [done.length ? "Imported: " + done.join(", ") : "", ...problems].filter(Boolean).join("\n");
  e.target.value = "";
  render();
});

function cleanBase() {
  let v = $("base").value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(v)) v = "http://" + v;
  new URL(v);  // throws if invalid
  return v;
}

$("save").addEventListener("click", async () => {
  const msg = $("msg");
  try {
    const baseUrl = cleanBase();
    await chrome.storage.local.set({ baseUrl, randomizeSeed: $("rand").checked, showImageButton: $("btn").checked });
    await syncOriginRule(baseUrl);
    $("base").value = baseUrl;
    msg.className = "msg ok"; msg.textContent = "Saved.";
  } catch (e) {
    msg.className = "msg err"; msg.textContent = "That address is not valid.";
  }
});

$("test").addEventListener("click", async () => {
  const msg = $("msg");
  msg.className = "msg"; msg.textContent = "Testing...";
  try {
    const base = cleanBase();
    await syncOriginRule(base);
    let res;
    try { res = await fetch(base + "/system_stats"); }
    catch (e) { throw new Error(explainNetworkError(base, 0)); }
    if (!res.ok) throw new Error(explainNetworkError(base, res.status));
    msg.className = "msg ok"; msg.textContent = "Connected to ComfyUI.";
  } catch (e) {
    msg.className = "msg err"; msg.textContent = e.message;
  }
});

render();
