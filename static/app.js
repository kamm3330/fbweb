// FBWeb – FreeBASIC Web-IDE (Frontend)

const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem("fbweb." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fbweb." + k, JSON.stringify(v)); } catch { } },
};
const TEMPLATE = `' Neues FreeBASIC-Programm\n\nDim As String n\nInput "Wie heisst du"; n\nPrint "Hallo "; n; "!"\n`;

// ------------------------------------------------------------------ Helfer
function toast(msg, err = false, ms = 3200) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (raw) opt.body = body;
    else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { }
  if (!r.ok) throw new Error((data && data.detail) || `${r.status} ${r.statusText}`);
  return data;
}
const q = p => encodeURIComponent(p);
const basename = p => p.split("/").pop();
const dirname = p => p.split("/").slice(0, -1).join("/");

function dialog({ title, text = "", value = null, ok = "OK", danger = false }) {
  return new Promise(res => {
    const m = $("#modal"), inp = $("#mInput"), okB = $("#mOk");
    $("#mTitle").textContent = title;
    $("#mText").textContent = text;
    inp.hidden = value === null;
    inp.value = value ?? "";
    okB.textContent = ok;
    okB.className = danger ? "danger" : "primary";
    m.hidden = false;
    const done = v => { m.hidden = true; okB.onclick = $("#mCancel").onclick = inp.onkeydown = null; res(v); cm.focus(); };
    okB.onclick = () => done(value === null ? true : inp.value.trim());
    $("#mCancel").onclick = () => done(null);
    inp.onkeydown = e => { if (e.key === "Enter") okB.onclick(); if (e.key === "Escape") done(null); };
    if (value !== null) {
      setTimeout(() => { inp.focus(); const dot = inp.value.lastIndexOf("."), sl = inp.value.lastIndexOf("/") + 1; inp.setSelectionRange(sl, dot > sl ? dot : inp.value.length); }, 0);
    } else setTimeout(() => okB.focus(), 0);
  });
}

// ------------------------------------------------------------------ Theme / Schrift
let theme = LS.get("theme", "dark");
let fontSize = LS.get("font", 14);
function applyLook() {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--ed-font", fontSize + "px");
  LS.set("theme", theme); LS.set("font", fontSize);
  if (window.cm) cm.refresh();
}
applyLook();

// ------------------------------------------------------------------ Editor
const cm = window.cm = CodeMirror($("#editorWrap"), {
  mode: "freebasic", theme: "fb", lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
  matchBrackets: true, autoCloseBrackets: { pairs: "()[]{}\"\"" }, styleActiveLine: true,
  highlightSelectionMatches: { showToken: /\w/, annotateScrollbar: true, minChars: 2 },
  foldGutter: true, gutters: ["err-gutter", "CodeMirror-linenumbers", "CodeMirror-foldgutter"],
  extraKeys: {
    "Tab": c => c.somethingSelected() ? c.indentSelection("add") : c.replaceSelection("    ", "end"),
    "Shift-Tab": c => c.indentSelection("subtract"),
    "Ctrl-Space": "autocomplete",
    "Ctrl-/": "toggleComment", "Ctrl-3": "toggleComment", "Cmd-/": "toggleComment",
    "Ctrl-H": "replace", "Ctrl-G": "jumpToLine",
    "F1": c => fbHelp(c),
  },
});
applyLook();
// Strg+# (deutsche Tastatur)
cm.on("keydown", (c, e) => { if (e.ctrlKey && e.key === "#") { e.preventDefault(); c.toggleComment(); } });
cm.on("cursorActivity", c => { const p = c.getCursor(); $("#sbPos").textContent = `Z ${p.line + 1}, S ${p.ch + 1}`; });

CodeMirror.registerHelper("hint", "freebasic", function (editor) {
  const cur = editor.getCursor(), tok = editor.getTokenAt(cur);
  const start = tok.string.match(/^\w/) ? tok.start : cur.ch, word = tok.string.slice(0, cur.ch - tok.start).toLowerCase();
  const local = CodeMirror.hint.anyword(editor, { word: /[\w$]+/ }).list;
  const set = new Set();
  const out = [];
  for (const w of window.FB_WORDS) if (w.startsWith(word) && !set.has(w)) { set.add(w); out.push(w.charAt(0).toUpperCase() + w.slice(1)); }
  for (const w of local) if (!set.has(w.toLowerCase())) { set.add(w.toLowerCase()); out.push(w); }
  return { list: out.slice(0, 80), from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, tok.end) };
});
cm.setOption("hintOptions", { completeSingle: false });
cm.on("inputRead", (c, ch) => {
  if (ch.origin !== "+input" || !/^[a-z]$/i.test(ch.text[0])) return;
  const tok = c.getTokenAt(c.getCursor());
  if (tok.type === "comment" || tok.type === "string") return;
  if (tok.string.length >= 3 && !c.state.completionActive) c.showHint({ hint: CodeMirror.hint.freebasic, completeSingle: false });
});

function fbHelp(c) {
  const w = c.findWordAt(c.getCursor());
  const word = c.getRange(w.anchor, w.head).replace(/[^\w]/g, "");
  if (!word) { window.open("https://www.freebasic.net/wiki/CatPgFullIndex", "_blank"); return; }
  window.open("https://www.freebasic.net/wiki/KeyPg" + word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(), "_blank");
}

// ------------------------------------------------------------------ Tabs
let tabs = [], active = null, untitledN = 1;

function makeTab(path, content, dirty = false) {
  const doc = CodeMirror.Doc(content, "freebasic");
  const t = { id: Math.random().toString(36).slice(2), path, name: path ? basename(path) : `unbenannt${untitledN++}.bas`, doc, clean: doc.changeGeneration(true) };
  if (dirty) t.clean = -1;
  doc.on("change", () => { renderTabs(); persistSoon(); });
  tabs.push(t);
  return t;
}
const isDirty = t => !t.doc.isClean(t.clean);

function activate(t) {
  active = t;
  cm.swapDoc(t.doc);
  renderTabs();
  $("#sbFile").textContent = t.path || "(nicht gespeichert)";
  document.title = `${t.name} – FBWeb`;
  applyMarks();
  cm.focus();
  persistSoon();
}

function renderTabs() {
  const el = $("#tabs");
  el.innerHTML = "";
  for (const t of tabs) {
    const d = document.createElement("div");
    d.className = "tab" + (t === active ? " active" : "") + (isDirty(t) ? " dirty" : "");
    d.title = t.path || "noch nicht gespeichert";
    d.innerHTML = `<span class="nm"></span><button class="x" title="Schließen">×</button>`;
    d.querySelector(".nm").textContent = t.name;
    d.onclick = () => activate(t);
    d.onauxclick = e => { if (e.button === 1) closeTab(t); };
    d.querySelector(".x").onclick = e => { e.stopPropagation(); closeTab(t); };
    el.appendChild(d);
  }
}

async function closeTab(t) {
  if (isDirty(t) && !(await dialog({ title: "Ungespeicherte Änderungen", text: `„${t.name}“ wurde geändert. Trotzdem schließen?`, ok: "Verwerfen", danger: true }))) return;
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (!tabs.length) makeTab(null, TEMPLATE);
  if (active === t) activate(tabs[Math.max(0, i - 1)]);
  else renderTabs();
  persistSoon();
}

function newFile() { activate(makeTab(null, TEMPLATE)); }

async function openFile(path) {
  const ex = tabs.find(t => t.path === path);
  if (ex) return activate(ex);
  try {
    const r = await api("GET", "/api/file?path=" + q(path));
    // leeren, unveränderten Start-Tab ersetzen
    if (tabs.length === 1 && !tabs[0].path && !isDirty(tabs[0])) tabs = [];
    activate(makeTab(path, r.content));
  } catch (e) { toast("Öffnen fehlgeschlagen: " + e.message, true); }
}

async function save(t = active, forceAs = false) {
  if (!t.path || forceAs) {
    const base = selected ? (selected.dir ? selected.path : dirname(selected.path)) : (drives.find(d => d.available)?.name || "lokal");
    let p = await dialog({ title: "Speichern unter", text: "Pfad (Laufwerk/Ordner/Datei.bas):", value: `${base}/${t.name}` });
    if (!p) return false;
    if (!/\.\w+$/.test(p)) p += ".bas";
    try { await api("PUT", "/api/file", { path: p, content: t.doc.getValue() }); }
    catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); return false; }
    t.path = p.replace(/^\/+/, ""); t.name = basename(t.path);
    await refreshDir(dirname(t.path));
  } else {
    try { await api("PUT", "/api/file", { path: t.path, content: t.doc.getValue() }); }
    catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); return false; }
  }
  t.clean = t.doc.changeGeneration(true);
  if (t === active) activate(t); else renderTabs();
  toast("Gespeichert: " + t.path, false, 1500);
  return true;
}

// Sitzung im Browser merken
let persistT = null;
function persistSoon() {
  clearTimeout(persistT);
  persistT = setTimeout(() => {
    LS.set("tabs", tabs.map(t => ({ path: t.path, name: t.name, content: (!t.path || isDirty(t)) ? t.doc.getValue() : null, active: t === active })));
  }, 400);
}
async function restoreTabs() {
  const saved = LS.get("tabs", []);
  let act = null;
  for (const s of saved) {
    let t = null;
    if (s.content !== null && s.content !== undefined) {
      t = makeTab(s.path, s.content, !!s.path);
      if (!s.path) t.name = s.name;
    } else if (s.path) {
      try { t = makeTab(s.path, (await api("GET", "/api/file?path=" + q(s.path))).content); } catch { }
    }
    if (t && s.active) act = t;
  }
  if (!tabs.length) makeTab(null, TEMPLATE);
  activate(act || tabs[0]);
}

// ------------------------------------------------------------------ Dateibaum
let drives = [], selected = null;
const expanded = new Set(LS.get("expanded", []));
const children = new Map();

async function loadStatus() {
  const s = await api("GET", "/api/status");
  drives = s.drives;
  window.DISPLAY_SIZE = s.display;
  $("#sbInfo").textContent = `${s.fbc.replace(/ \(.*?\)/, "").replace("FreeBASIC Compiler - ", "FreeBASIC ").replace(/, built for.*/, "")} · Sandbox ${s.sandbox ? "an" : "aus"}`;
  for (const d of drives) if (d.available) expanded.add(d.name);
  return s;
}

async function refreshDir(path) {
  try {
    const r = await api("GET", "/api/list?path=" + q(path));
    children.set(path, r.items);
  } catch (e) { children.set(path, { error: e.message }); }
  renderTree();
}

async function refreshAll() {
  await loadStatus();
  children.clear();
  await Promise.all([...expanded].filter(p => {
    const d = drives.find(x => x.name === p.split("/")[0]);
    return d && d.available;
  }).map(p => api("GET", "/api/list?path=" + q(p)).then(r => children.set(p, r.items)).catch(() => expanded.delete(p))));
  renderTree();
}

function renderTree() {
  const el = $("#tree");
  el.innerHTML = "";
  const add = (depth, html, cls, onclick, path, isDir) => {
    const n = document.createElement("div");
    n.className = "node " + cls + (selected && selected.path === path ? " sel" : "");
    n.style.paddingLeft = 6 + depth * 14 + "px";
    n.innerHTML = html;
    n.onclick = e => onclick(e, n);
    if (!isDir) n.ondblclick = () => openFile(path);
    el.appendChild(n);
    return n;
  };
  const walk = (path, depth) => {
    const items = children.get(path);
    if (!items) return;
    if (items.error) { add(depth, `<span class="tw"></span><span class="nm err">${items.error}</span>`, "", () => { }, ""); return; }
    for (const it of items) {
      const p = path + "/" + it.name, open = expanded.has(p);
      const icon = it.dir ? (open ? "📂" : "📁") : /\.(bas|bi)$/i.test(it.name) ? "📝" : "📄";
      const n = add(depth, `<span class="tw">${it.dir ? (open ? "▾" : "▸") : ""}</span><span class="ic">${icon}</span><span class="nm"></span>`, "", async () => {
        selected = { path: p, dir: it.dir };
        if (it.dir) { toggle(p); } else { renderTree(); if (/\.(bas|bi|txt|ini|cfg|conf|md|csv|log|json|xml|bat|sh|c|h)$/i.test(it.name)) openFile(p); }
      }, p, it.dir);
      n.querySelector(".nm").textContent = it.name;
      n.title = it.dir ? p : `${p}\n${(it.size / 1024).toFixed(1)} KB · ${new Date(it.mtime * 1000).toLocaleString("de-DE")}`;
      if (it.dir && open) walk(p, depth + 1);
    }
  };
  for (const d of drives) {
    const open = expanded.has(d.name) && d.available;
    const n = add(0, `<span class="tw">${d.available ? (open ? "▾" : "▸") : ""}</span><span class="ic">${d.type === "sshfs" ? "🌐" : "💾"}</span><span class="nm"></span>`,
      "drive" + (d.available ? "" : " off"), async (e) => {
        if (e.target.classList.contains("act")) return;
        selected = { path: d.name, dir: true, drive: true };
        if (d.available) toggle(d.name); else renderTree();
      }, d.name, true);
    n.querySelector(".nm").textContent = d.name;
    n.title = `${d.type === "sshfs" ? "sshfs: " : "lokal: "}${d.remote}${d.error ? "\nFehler: " + d.error : ""}`;
    if (d.type === "sshfs" && d.enabled) {
      const b = document.createElement("button");
      b.className = "act";
      b.textContent = d.available ? "trennen" : "verbinden";
      b.onclick = async ev => {
        ev.stopPropagation();
        b.disabled = true; b.textContent = "…";
        try {
          const r = await api("POST", `/api/drives/${d.name}/${d.available ? "unmount" : "mount"}`);
          if (r.error) toast(`${d.name}: ${r.error}`, true, 6000);
        } catch (er) { toast(er.message, true); }
        await refreshAll();
      };
      n.appendChild(b);
    } else if (d.type === "sshfs") {
      const s = document.createElement("span"); s.className = "err"; s.textContent = "deaktiviert"; n.appendChild(s);
    }
    if (open) walk(d.name, 1);
  }
  LS.set("expanded", [...expanded]);
}

async function toggle(p) {
  if (expanded.has(p)) { expanded.delete(p); renderTree(); }
  else { expanded.add(p); await refreshDir(p); }
}

const selDir = () => selected ? (selected.dir ? selected.path : dirname(selected.path)) : drives.find(d => d.available)?.name;

$("#fNewFile").onclick = async () => {
  const dir = selDir(); if (!dir) return;
  let n = await dialog({ title: "Neue Datei", text: `in ${dir}/`, value: "programm.bas" });
  if (!n) return;
  if (!/\.\w+$/.test(n)) n += ".bas";
  const p = `${dir}/${n}`;
  try { await api("PUT", "/api/file", { path: p, content: /\.bas$/i.test(n) ? TEMPLATE : "", create: true }); }
  catch (e) { return toast(e.message, true); }
  expanded.add(dir); await refreshDir(dir); openFile(p);
};
$("#fNewDir").onclick = async () => {
  const dir = selDir(); if (!dir) return;
  const n = await dialog({ title: "Neuer Ordner", text: `in ${dir}/`, value: "neuer_ordner" });
  if (!n) return;
  try { await api("POST", "/api/mkdir", { path: `${dir}/${n}` }); } catch (e) { return toast(e.message, true); }
  expanded.add(dir); await refreshDir(dir);
};
$("#fRename").onclick = async () => {
  if (!selected || selected.drive) return toast("Bitte zuerst eine Datei oder einen Ordner wählen");
  const n = await dialog({ title: "Umbenennen", value: basename(selected.path) });
  if (!n || n === basename(selected.path)) return;
  const to = dirname(selected.path) + "/" + n;
  try { await api("POST", "/api/rename", { from: selected.path, to }); } catch (e) { return toast(e.message, true); }
  for (const t of tabs) if (t.path && (t.path === selected.path || t.path.startsWith(selected.path + "/"))) {
    t.path = to + t.path.slice(selected.path.length); t.name = basename(t.path);
  }
  selected.path = to; renderTabs(); persistSoon();
  await refreshDir(dirname(to));
};
$("#fDelete").onclick = async () => {
  if (!selected || selected.drive) return toast("Bitte zuerst eine Datei oder einen Ordner wählen");
  if (!(await dialog({ title: "Löschen", text: `„${selected.path}“ ${selected.dir ? "mit gesamtem Inhalt " : ""}wirklich löschen?`, ok: "Löschen", danger: true }))) return;
  try { await api("POST", "/api/delete", { path: selected.path }); } catch (e) { return toast(e.message, true); }
  for (const t of tabs) if (t.path && (t.path === selected.path || t.path.startsWith(selected.path + "/"))) { t.path = null; t.clean = -1; }
  const d = dirname(selected.path); selected = null; renderTabs(); await refreshDir(d);
};
$("#fUpload").onclick = () => { if (selDir()) $("#uploadInput").click(); };
$("#uploadInput").onchange = async e => {
  const dir = selDir();
  for (const f of e.target.files) {
    try { await api("POST", `/api/upload?path=${q(dir + "/" + f.name)}`, await f.arrayBuffer(), true); }
    catch (er) { toast(`${f.name}: ${er.message}`, true); }
  }
  e.target.value = "";
  expanded.add(dir); await refreshDir(dir);
};
$("#fDownload").onclick = () => {
  if (!selected || selected.dir) return toast("Bitte eine Datei wählen");
  window.open("/api/download?path=" + q(selected.path));
};
$("#fRefresh").onclick = refreshAll;

// ------------------------------------------------------------------ Konsole
const term = new Terminal({
  fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"), fontSize: 14, cursorBlink: true,
  convertEol: false, scrollback: 5000, allowProposedApi: true,
  theme: { background: "#0d1014", foreground: "#d5dbe1", cursor: "#4c8dff", selectionBackground: "#2f4a74" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("#console"));
term.writeln("\x1b[2mFBWeb-Konsole – Ausgaben und Eingaben (PRINT / INPUT) des Programms erscheinen hier.\x1b[0m");
term.writeln("\x1b[2mF5 = Ausführen, Umschalt+F5 = Stopp, Strg+C im Programm = Abbruch.\x1b[0m");
// Tastatureingaben gehen direkt an das Programm. (Die Laufzeitbibliothek ist so
// gepatcht, dass sie im FBWeb-Betrieb keine Cursorpositions-Abfragen mehr schickt,
// die sich mit schnell getippten Zeichen vermischen könnten.)
term.onData(d => { if (runState === "running") send({ t: "in", d }); });
function fitTerm() {
  try { fit.fit(); } catch { }
  send({ t: "resize", cols: term.cols, rows: term.rows });
}
new ResizeObserver(() => { fitTerm(); layoutGfx(); }).observe($("#bottomPane"));
$("#conClear").onclick = () => term.clear();
$("#conFull").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#bottomPane").requestFullscreen().then(() => term.focus()).catch(() => { });
};
document.addEventListener("fullscreenchange", () => setTimeout(() => { fitTerm(); layoutGfx(); cm.refresh(); }, 80));

document.querySelectorAll(".ptab").forEach(b => b.onclick = () => showPanel(b.dataset.panel));
function showPanel(name) {
  document.querySelectorAll(".ptab").forEach(b => b.classList.toggle("active", b.dataset.panel === name));
  $("#console").hidden = name !== "console";
  $("#messages").hidden = name !== "messages";
  if (name === "console") setTimeout(fitTerm, 0);
}

// ------------------------------------------------------------------ Kompiliermeldungen
let marks = { file: null, msgs: [] };
function applyMarks() {
  cm.clearGutter("err-gutter");
  for (let i = 0; i < cm.lineCount(); i++) { cm.removeLineClass(i, "background", "line-error"); cm.removeLineClass(i, "background", "line-warning"); }
  if (!active || active.name.toLowerCase() !== (marks.file || "").toLowerCase()) return;
  for (const m of marks.msgs) {
    const ln = m.line - 1;
    if (ln < 0 || ln >= cm.lineCount()) continue;
    const g = document.createElement("span");
    g.className = "err-mark " + m.kind; g.textContent = m.kind === "error" ? "✖" : "▲"; g.title = m.text;
    cm.setGutterMarker(ln, "err-gutter", g);
    cm.addLineClass(ln, "background", m.kind === "error" ? "line-error" : "line-warning");
  }
}
function showCompile(r, fileName) {
  const el = $("#messages");
  el.innerHTML = "";
  const errs = r.msgs.filter(m => m.kind === "error").length, warns = r.msgs.length - errs;
  const s = document.createElement("div");
  s.className = "msg-summary " + (r.ok ? "ok" : "err");
  s.textContent = r.ok ? `✔ Kompiliert in ${r.time} s${warns ? ` – ${warns} Warnung(en)` : ""}` : `✖ Kompilieren fehlgeschlagen – ${errs || "?"} Fehler${warns ? `, ${warns} Warnung(en)` : ""}`;
  el.appendChild(s);
  for (const m of r.msgs) {
    const d = document.createElement("div");
    d.className = "msg " + m.kind;
    d.innerHTML = `<span class="k">${m.kind === "error" ? "Fehler" : "Warnung"}</span><span class="ln"></span><span class="tx"></span>`;
    d.querySelector(".ln").textContent = `${m.file}:${m.line}`;
    d.querySelector(".tx").textContent = m.text;
    d.onclick = () => {
      const t = tabs.find(t => t.name.toLowerCase() === m.file.toLowerCase());
      if (t && t !== active) activate(t);
      cm.setCursor({ line: m.line - 1, ch: 0 }); cm.scrollIntoView(null, 120); cm.focus();
    };
    el.appendChild(d);
  }
  if (r.log && !r.msgs.length && !r.ok) { const p = document.createElement("pre"); p.className = "rawlog"; p.textContent = r.log; el.appendChild(p); }
  const b = $("#msgCount");
  b.hidden = !r.msgs.length; b.textContent = r.msgs.length; b.classList.toggle("ok", !errs);
  marks = { file: fileName, msgs: r.msgs };
  applyMarks();
  if (!r.ok) showPanel("messages");
}

// ------------------------------------------------------------------ Ausführen (WebSocket)
let ws = null, runState = "idle", pendingClean = null, wsRetry = null;
const wsUrl = p => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + p;

function connectRun() {
  ws = new WebSocket(wsUrl("/ws/run"));
  ws.onopen = () => { $("#sbConn").classList.add("on"); $("#sbConn").title = "Verbunden mit dem Server"; fitTerm(); };
  ws.onclose = () => {
    $("#sbConn").classList.remove("on"); $("#sbConn").title = "Keine Verbindung zum Server";
    setRunState("idle");
    clearTimeout(wsRetry); wsRetry = setTimeout(connectRun, 2000);
  };
  ws.onmessage = ev => onRunMsg(JSON.parse(ev.data));
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function setRunState(s) {
  runState = s;
  const el = $("#runState");
  el.className = "state " + s;
  el.textContent = { idle: "bereit", compiling: "kompiliert …", running: "läuft", error: "Fehler" }[s] || s;
  $("#btnStop").disabled = !(s === "running" || s === "compiling");
}

function onRunMsg(m) {
  switch (m.t) {
    case "status":
      if (m.s === "idle" && runState === "error") return;
      setRunState(m.s);
      if (m.s === "running") { showPanel("console"); term.focus(); }
      break;
    case "compile":
      if (pendingClean && m.ok !== undefined) {
        const { tab, gen } = pendingClean;
        if (tab.path) { tab.clean = gen; renderTabs(); persistSoon(); }
        pendingClean = null;
      }
      showCompile(m, runFile);
      if (!m.ok) { setRunState("error"); term.writeln("\r\n\x1b[31m✖ Kompilieren fehlgeschlagen – siehe „Meldungen“.\x1b[0m"); }
      else term.reset();
      break;
    case "out": term.write(m.d); break;
    case "exit": {
      let txt;
      if (m.stopped) txt = "Programm abgebrochen";
      else if (m.signal) txt = `Programm beendet durch Signal ${m.signal}`;
      else txt = `Programm beendet (Rückgabewert ${m.code}${m.time !== undefined ? `, ${m.time} s` : ""})`;
      term.write(`\r\n\x1b[2m── ${txt} ──\x1b[0m\r\n`);
      break;
    }
    case "error": term.write(`\r\n\x1b[31m${m.msg}\x1b[0m\r\n`); toast(m.msg, true); break;
  }
}

let runFile = null;
async function run() {
  if (!ws || ws.readyState !== 1) return toast("Keine Verbindung zum Server", true);
  const t = active;
  pendingClean = { tab: t, gen: t.doc.changeGeneration(true) };
  runFile = t.path ? t.name : "unbenannt.bas";
  fitTerm();
  setRunState("compiling");
  send({ t: "run", path: t.path, code: t.doc.getValue(), cols: term.cols, rows: term.rows });
}
function stop() { send({ t: "stop" }); }

// ------------------------------------------------------------------ Grafik (eigener gfxlib2-Treiber "FBWeb")
const canvas = $("#gfxCanvas"), ctx = canvas.getContext("2d", { alpha: false });
let gws = null, gfx = { w: 0, h: 0, title: "" }, img = null, zoom = LS.get("zoom", "auto"), frameChain = Promise.resolve();
$("#gfxZoom").value = zoom;

function gsend(o) { if (gws && gws.readyState === 1) gws.send(JSON.stringify(o)); }

async function inflate(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function connectGfx() {
  if (typeof DecompressionStream === "undefined") { $("#gfxState").textContent = "Dieser Browser ist zu alt für die Grafikausgabe."; return; }
  gws = new WebSocket(wsUrl("/ws/gfx"));
  gws.binaryType = "arraybuffer";
  gws.onopen = () => { $("#gfxState").textContent = ""; };
  gws.onclose = () => {
    $("#gfxState").textContent = "Grafik-Verbindung getrennt – verbinde neu …";
    setGfx({ w: 0, h: 0 });
    setTimeout(connectGfx, 2000);
  };
  gws.onmessage = ev => {
    if (typeof ev.data === "string") {
      const m = JSON.parse(ev.data);
      if (m.t === "mode") setGfx({ w: m.w, h: m.h, title: m.title || "" });
      else if (m.t === "title") { gfx.title = m.title; showTitle(); }
      else if (m.t === "close") setGfx({ w: 0, h: 0 });
      else if (m.t === "cursor") canvas.style.cursor = m.on ? "default" : "none";
      return;
    }
    // Binär: u16 y, u16 Zeilen, u16 Breite, danach zlib-komprimierte RGBX-Pixel
    const buf = ev.data, dv = new DataView(buf);
    const y = dv.getUint16(0, true), n = dv.getUint16(2, true), w = dv.getUint16(4, true);
    const myImg = img;
    frameChain = frameChain.then(async () => {
      const px = await inflate(buf.slice(6));
      if (img !== myImg || !img || w !== img.width || (y + n) > img.height) return;
      const d = img.data, off = y * w * 4;
      d.set(px.subarray(0, n * w * 4), off);
      for (let i = off + 3, e = off + n * w * 4; i < e; i += 4) d[i] = 255;
      ctx.putImageData(img, 0, 0, 0, y, w, n);
    }).catch(err => console.error("Grafik:", err));
  };
}

function showTitle() {
  $("#gfxTitle").textContent = gfx.w ? `– ${gfx.title || "Fenster"} (${gfx.w}×${gfx.h})` : "";
}

function setGfx(m) {
  const had = gfx.w > 0;
  gfx = { w: m.w, h: m.h, title: m.title || "" };
  if (m.w) {
    canvas.width = m.w; canvas.height = m.h;
    img = ctx.createImageData(m.w, m.h);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    canvas.style.cursor = "default";
  } else img = null;
  showTitle();
  layoutGfx();
  if (m.w && !had) setTimeout(() => canvas.focus(), 30);
  if (!m.w && had && document.activeElement === canvas) term.focus();
}

function layoutGfx() {
  const body = $("#gfxBody");
  if (!gfx.w) { canvas.hidden = true; $("#gfxPlaceholder").hidden = false; return; }
  $("#gfxPlaceholder").hidden = true; canvas.hidden = false;
  const pw = body.clientWidth - 8, ph = body.clientHeight - 8;
  let z;
  if (zoom === "auto") { z = Math.min(pw / gfx.w, ph / gfx.h); if (z >= 1) z = Math.floor(z); }
  else z = Number(zoom);
  z = Math.max(z, 0.1);
  canvas.style.width = Math.round(gfx.w * z) + "px";
  canvas.style.height = Math.round(gfx.h * z) + "px";
}
new ResizeObserver(layoutGfx).observe($("#gfxBody"));
$("#gfxZoom").onchange = e => { zoom = e.target.value; LS.set("zoom", zoom); layoutGfx(); };
$("#gfxFull").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#gfxPane").requestFullscreen().then(() => setTimeout(() => { layoutGfx(); canvas.focus(); }, 100)).catch(() => { });
};
$("#gfxClose").onclick = () => gsend({ t: "close" });

// ---- Tastatur: Browser-Taste -> DOS-Scancode (wie MULTIKEY / SC_xxx) + Zeichen (INKEY)
const SC = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22,
  KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, ControlRight: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40,
  Backquote: 41, ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, AltRight: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, NumLock: 69, ScrollLock: 70,
  Home: 71, ArrowUp: 72, PageUp: 73, NumpadSubtract: 74, ArrowLeft: 75, Numpad5: 76, ArrowRight: 77, NumpadAdd: 78,
  End: 79, ArrowDown: 80, PageDown: 81, Insert: 82, Delete: 83, IntlBackslash: 86, F11: 87, F12: 88,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93, Numpad7: 71, Numpad8: 72, Numpad9: 73, Numpad4: 75, Numpad6: 77,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83, NumpadEnter: 28, NumpadDivide: 53,
};
const LETTER_SC = { q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, a: 30, s: 31, d: 32, f: 33, g: 34,
  h: 35, j: 36, k: 37, l: 38, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50 };
function scancode(e) {
  // Buchstaben nach Tastenbeschriftung (wie X11 unter FreeBASIC), damit Y/Z auf deutscher Tastatur stimmen
  if (e.key && e.key.length === 1 && LETTER_SC[e.key.toLowerCase()] && /^Key/.test(e.code)) return LETTER_SC[e.key.toLowerCase()];
  return SC[e.code] || 0;
}
function keyValue(e) {
  const k = e.key;
  if (k.length === 1) {
    if (e.ctrlKey && !e.altKey && /[a-z]/i.test(k)) return k.toUpperCase().charCodeAt(0) - 64;
    const c = k.charCodeAt(0);
    return c < 256 ? c : 0;
  }
  return { Enter: 13, Backspace: 8, Tab: 9, Escape: 27 }[k] || 0;
}
const down = new Set();
canvas.addEventListener("keydown", e => {
  e.preventDefault(); e.stopPropagation();
  const sc = scancode(e);
  down.add(sc);
  gsend({ t: "key", down: true, sc, key: keyValue(e), rep: e.repeat });
});
canvas.addEventListener("keyup", e => {
  e.preventDefault(); e.stopPropagation();
  const sc = scancode(e);
  down.delete(sc);
  gsend({ t: "key", down: false, sc, key: keyValue(e) });
});
canvas.addEventListener("focus", () => gsend({ t: "focus", on: true }));
canvas.addEventListener("blur", () => {
  for (const sc of down) gsend({ t: "key", down: false, sc, key: 0 });
  down.clear();
  gsend({ t: "focus", on: false });
});

// ---- Maus
let pendingMove = null;
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(gfx.w - 1, Math.floor((e.clientX - r.left) * gfx.w / r.width))),
    y: Math.max(0, Math.min(gfx.h - 1, Math.floor((e.clientY - r.top) * gfx.h / r.height))),
  };
}
canvas.addEventListener("pointermove", e => {
  if (!gfx.w) return;
  const first = !pendingMove;
  pendingMove = canvasPos(e);
  if (first) requestAnimationFrame(() => { if (pendingMove) gsend({ t: "move", ...pendingMove }); pendingMove = null; });
});
const BTN = [1, 4, 2, 8, 16];   // Browser: 0 links, 1 Mitte, 2 rechts -> FreeBASIC-Bits
canvas.addEventListener("pointerdown", e => {
  if (!gfx.w) return;
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  gsend({ t: "move", ...canvasPos(e) });
  gsend({ t: "btn", b: BTN[e.button] || 1, down: true });
  e.preventDefault();
});
canvas.addEventListener("pointerup", e => {
  if (!gfx.w) return;
  gsend({ t: "move", ...canvasPos(e) });
  gsend({ t: "btn", b: BTN[e.button] || 1, down: false });
});
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.deltaY) gsend({ t: "wheel", dz: e.deltaY < 0 ? 1 : -1, dw: 0 });
  else if (e.deltaX) gsend({ t: "wheel", dz: 0, dw: e.deltaX < 0 ? -1 : 1 });
}, { passive: false });

// ------------------------------------------------------------------ Trennlinien
document.querySelectorAll(".splitter").forEach(sp => {
  const target = document.getElementById(sp.dataset.target), vert = sp.classList.contains("v"), inv = !!sp.dataset.invert;
  const key = "size." + sp.dataset.target;
  const savedSize = LS.get(key, null);
  if (savedSize) target.style[vert ? "width" : "height"] = savedSize + "px";
  sp.addEventListener("pointerdown", e => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("drag");
    const start = vert ? e.clientX : e.clientY, size = vert ? target.offsetWidth : target.offsetHeight;
    const move = ev => {
      const d = (vert ? ev.clientX : ev.clientY) - start;
      const ns = Math.max(80, size + (inv ? -d : d));
      target.style[vert ? "width" : "height"] = ns + "px";
      cm.refresh();
    };
    const up = () => {
      sp.classList.remove("drag");
      sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up);
      LS.set(key, vert ? target.offsetWidth : target.offsetHeight);
      fitTerm(); layoutGfx(); cm.refresh();
    };
    sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up);
  });
});

// ------------------------------------------------------------------ Knöpfe & Tastatur
$("#btnNew").onclick = newFile;
$("#btnSave").onclick = () => save();
$("#btnSaveAs").onclick = () => save(active, true);
$("#btnRun").onclick = run;
$("#btnStop").onclick = stop;
$("#btnFind").onclick = () => { cm.focus(); cm.execCommand("find"); };
$("#btnFontPlus").onclick = () => { fontSize = Math.min(28, fontSize + 1); applyLook(); };
$("#btnFontMinus").onclick = () => { fontSize = Math.max(9, fontSize - 1); applyLook(); };
$("#btnTheme").onclick = () => { theme = theme === "dark" ? "light" : "dark"; applyLook(); };
$("#btnHelp").onclick = () => { $("#helpModal").hidden = false; };

// Dateispalte ein-/ausklappen
function setSidebar(open) {
  document.body.classList.toggle("no-sidebar", !open);
  LS.set("sidebar", open);
  setTimeout(() => { cm.refresh(); fitTerm(); layoutGfx(); }, 0);
}
$("#btnSidebar").onclick = () => setSidebar(document.body.classList.contains("no-sidebar"));
setSidebar(LS.get("sidebar", true));

// Uhr
function tick() {
  const d = new Date();
  $("#clock").innerHTML = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }) +
    " <b>" + d.toLocaleTimeString("de-DE") + "</b>";
  $("#clock").title = d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
tick();
setInterval(tick, 1000);
$("#helpClose").onclick = () => { $("#helpModal").hidden = true; cm.focus(); };

document.addEventListener("keydown", e => {
  if (e.target.id === "gfxCanvas") return;   // Tasten gehören dem Grafikprogramm
  const k = e.key.toLowerCase();
  if (e.key === "F5" && e.shiftKey) { e.preventDefault(); stop(); }
  else if (e.key === "F5") { e.preventDefault(); run(); }
  else if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); save(active, e.shiftKey); }
  else if ((e.ctrlKey || e.metaKey) && k === "n" && !e.shiftKey) { e.preventDefault(); newFile(); }
  else if ((e.ctrlKey || e.metaKey) && k === "b" && !e.shiftKey) { e.preventDefault(); $("#btnSidebar").click(); }
  else if (e.key === "Escape" && !$("#helpModal").hidden) { $("#helpModal").hidden = true; }
}, true);

window.addEventListener("beforeunload", e => {
  persistSoon();
  if (tabs.some(t => t.path && isDirty(t))) { e.preventDefault(); e.returnValue = ""; }
});

// ------------------------------------------------------------------ Start
(async () => {
  try { await refreshAll(); } catch (e) { toast("Server nicht erreichbar: " + e.message, true, 8000); }
  await restoreTabs();
  connectRun();
  connectGfx();
  setTimeout(fitTerm, 100);
})();
