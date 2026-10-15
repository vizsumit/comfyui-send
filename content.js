// Shows a small "send to ComfyUI" button on the top-right corner of images you hover.
(() => {
  if (window.__comfySendLoaded) return;
  window.__comfySendLoaded = true;
  // Skip tiny frames (ads, trackers)
  if (
    window !== window.top &&
    (window.innerWidth < 100 || window.innerHeight < 100)
  )
    return;

  const SIZE = 24;
  const MARGIN = 8;
  const MIN_SHOWN = 320; // smallest displayed image that gets a button (px)
  const MIN_NATURAL = 32; // ignore 1x1 placeholders
  const COLORS = {
    idle: "#131313",
    busy: "#131313",
    ok: "#7bd88f",
    err: "#ff8a8a",
  };

  let enabled = false,
    current = null,
    busy = false;
  let hideTimer = null,
    raf = 0,
    lastX = 0,
    lastY = 0;

  // ---------- Button (inside a closed shadow root so page CSS can't touch it) ----------
  const host = document.createElement("div");
  host.style.cssText =
    "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Send to ComfyUI";
  btn.setAttribute("aria-label", "Send image to ComfyUI");
  Object.assign(btn.style, {
    all: "initial",
    boxSizing: "border-box",
    position: "fixed",
    display: "none",
    width: SIZE + "px",
    height: SIZE + "px",
    padding: "0",
    margin: "0",
    border: "0",
    borderRadius: "2px",
    cursor: "pointer",
    pointerEvents: "auto",
    color: "#f4c95d",
    boxShadow: "0 0 0 1px rgba(0,0,0,.45), 0 1px 3px rgba(0,0,0,.4)",
    font: "700 10px/14px system-ui, sans-serif",
    textAlign: "center",
    userSelect: "none",
  });
  root.appendChild(btn);

  function arrowIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 13 13");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.style.cssText = "display:block;margin:2px;pointer-events:none;";
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M1.5 5h6.5M5.5 2 8.5 5 5.5 8");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function setState(kind, tip) {
    btn.style.background = COLORS[kind];
    btn.title = tip || "Send to ComfyUI";
    if (kind === "idle") btn.replaceChildren(arrowIcon());
    else
      btn.replaceChildren(
        document.createTextNode({ busy: "…", ok: "✓", err: "!" }[kind]),
      );
  }
  setState("idle");

  // Keep clicks away from the page (lightboxes, link navigation, etc.)
  for (const type of [
    "pointerdown",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
  ]) {
    btn.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === "click") e.preventDefault();
    });
  }

  // ---------- Finding the image under the cursor ----------
  // elementsFromPoint sees through the transparent overlays that Instagram, X and Reddit put above photos.
  function stackAt(rootNode, x, y, out, seen = new Set(), depth = 0) {
    if (depth > 4 || seen.has(rootNode)) return out;
    seen.add(rootNode);
    let els = [];
    try {
      els = rootNode.elementsFromPoint(x, y);
    } catch (e) {
      return out;
    }
    for (const el of els) {
      out.push(el);
      if (el.shadowRoot) stackAt(el.shadowRoot, x, y, out, seen, depth + 1);
    }
    return out;
  }
  
  function usable(img) {
    if (!img.isConnected) return false;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_SHOWN || r.height < MIN_SHOWN) return false;
    if (img.naturalWidth < MIN_NATURAL || img.naturalHeight < MIN_NATURAL)
      return false;
    return !!(img.currentSrc || img.src);
  }

  function imageAt(x, y) {
    for (const el of stackAt(document, x, y, [])) {
      if (el !== host && el instanceof HTMLImageElement && usable(el))
        return el;
    }
    return null;
  }

  // ---------- Positioning ----------
  function place(img) {
    if (!img.isConnected) {
      hide(true);
      return;
    }
    const r = img.getBoundingClientRect();
    const right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0);
    btn.style.left = Math.max(0, right - SIZE - MARGIN) + "px";
    btn.style.top = top + MARGIN + "px";
  }
  function show(img) {
    current = img;
    place(img);
    btn.style.display = "block";
  }
  function hide(force) {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (busy && !force) return;
    current = null;
    btn.style.display = "none";
  }

  // ---------- Events ----------
  function check() {
    raf = 0;
    const img = imageAt(lastX, lastY);
    if (img) {
      clearTimeout(hideTimer);
      hideTimer = null;
      if (img !== current || btn.style.display === "none") show(img);
      else place(img);
    } else if (current && !hideTimer) {
      hideTimer = setTimeout(() => hide(false), 200);
    }
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!enabled) return;
      if (e.target === host) {
        clearTimeout(hideTimer);
        hideTimer = null;
        return;
      } // pointer is on our button
      lastX = e.clientX;
      lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(check);
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "scroll",
    () => {
      if (current) place(current);
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    "resize",
    () => {
      if (current) place(current);
    },
    { passive: true },
  );
  document.addEventListener("mouseleave", () => hide(false), { passive: true });

  // ---------- Sending ----------
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // blob: URLs only exist inside this page, so read them here and pass the bytes along.
  async function sourceFor(img) {
    const src = img.currentSrc || img.src;
    if (src.startsWith("blob:"))
      return blobToDataUrl(await (await fetch(src)).blob());
    return src;
  }

  btn.addEventListener("click", async () => {
    if (busy || !current) return;
    busy = true;
    setState("busy", "Sending…");
    let ok = false,
      tip = "";
    try {
      const url = await sourceFor(current);
      const res = await chrome.runtime.sendMessage({ type: "send-image", url });
      ok = !!(res && res.ok);
      tip = ok ? "Sent to ComfyUI" : (res && res.error) || "Could not send";
    } catch (e) {
      tip =
        "Could not send. If you just updated the extension, reload this page.";
    }
    setState(ok ? "ok" : "err", tip);
    setTimeout(
      () => {
        busy = false;
        setState("idle");
      },
      ok ? 1200 : 2500,
    );
  });

  // ---------- Settings ----------
  async function refresh() {
    try {
      const s = await chrome.storage.local.get({
        workflows: {},
        activeId: null,
        showImageButton: true,
      });
      const id = s.workflows[s.activeId]
        ? s.activeId
        : Object.keys(s.workflows)[0];
      const wf = id && s.workflows[id].workflow;
      enabled = !!(
        s.showImageButton &&
        wf &&
        findNodes(wf, IMAGE_TITLE).length
      );
    } catch (e) {
      enabled = false; // extension was reloaded; this page needs a refresh
    }
    if (!enabled) hide(true);
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (
        area === "local" &&
        (changes.workflows || changes.activeId || changes.showImageButton)
      )
        refresh();
    });
  } catch (e) {}

  document.documentElement.appendChild(host);
  refresh();
})();
