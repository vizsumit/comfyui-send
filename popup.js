const pick = document.getElementById("pick");
document.getElementById("help").href = HELP_URL;
document.getElementById("manage").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });

async function render() {
  const s = await loadState();
  const ids = Object.keys(s.workflows);
  pick.textContent = "";
  if (!ids.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No workflows yet.";
    pick.appendChild(p);
    return;
  }
  const label = document.createElement("label");
  label.textContent = "Current workflow";
  label.htmlFor = "sel";
  const sel = document.createElement("select");
  sel.id = "sel";
  ids.forEach(id => {
    const o = document.createElement("option");
    o.value = id; o.textContent = id;
    sel.appendChild(o);
  });
  sel.value = s.activeId;
  sel.addEventListener("change", () => chrome.storage.local.set({ activeId: sel.value }));
  pick.append(label, sel);
}
render();
