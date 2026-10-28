(() => {
  let schema = window.DQL_SCHEMA;
  const PARAM_TYPES = ["string", "int", "float", "bool"];
  const FILTER_FUNCS = [
    { value: "eq", label: "eq" },
    { value: "ge", label: "ge" },
    { value: "le", label: "le" },
    { value: "gt", label: "gt" },
    { value: "lt", label: "lt" },
    { value: "has", label: "has" },
    { value: "alloftext", label: "alloftext" },
    { value: "anyoftext", label: "anyoftext" },
    { value: "allofterms", label: "allofterms" },
    { value: "anyofterms", label: "anyofterms" },
    { value: "regexp", label: "regexp" },
    { value: "uid_in", label: "uid_in" },
    { value: "not eq", label: "not eq" },
    { value: "not has", label: "not has" },
    { value: "uid", label: "uid" },
    { value: "not uid", label: "not uid" },
  ];

  function isUnaryFilter(func) {
    const f = String(func || "").replace(/^not\s+/i, "").toLowerCase();
    return f === "has";
  }

  /** uid(v) / not uid(v): keep nodes that are (not) in a query variable. */
  function isVarFilter(func) {
    return /^(not\s+)?uid$/i.test(String(func || "").trim());
  }

  const canvasEl = document.getElementById("canvas");
  const canvasSurfaceEl = document.getElementById("canvasSurface");
  const canvasEmptyEl = document.getElementById("canvasEmpty");
  const addEntityBtn = document.getElementById("addEntityBtn");
  const entityMenuEl = document.getElementById("entityMenu");
  const entityMenuWrap = document.getElementById("entityMenuWrap");
  const copyBtn = document.getElementById("copyBtn");
  const copyVarsBtn = document.getElementById("copyVarsBtn");
  const clearBtn = document.getElementById("clearBtn");
  const applyDqlBtn = document.getElementById("applyDqlBtn");
  const revertDqlBtn = document.getElementById("revertDqlBtn");
  const dqlDirtyBadge = document.getElementById("dqlDirtyBadge");
  const dqlEditHint = document.getElementById("dqlEditHint");
  const entitySearchEl = document.getElementById("entitySearch");
  const entityMenuListEl = document.getElementById("entityMenuList");
  const emptyAddBtn = document.getElementById("emptyAddBtn");
  const blockCountEl = document.getElementById("blockCount");
  const schemaLabelEl = document.getElementById("schemaLabel");
  const workspaceEl = document.getElementById("workspace");
  const splitterEl = document.getElementById("splitter");
  const consoleOutputEl = document.getElementById("consoleBody");
  const consoleToggleBtn = document.getElementById("consoleToggle");
  const consoleToolsEl = document.getElementById("consoleTools");
  const consoleLastEl = document.getElementById("consoleLast");
  const consoleLevelEl = document.getElementById("consoleLevel");
  const consoleClearBtn = document.getElementById("consoleClearBtn");
  const consoleErrorCountEl = document.getElementById("consoleErrorCount");
  const consoleWarnCountEl = document.getElementById("consoleWarnCount");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const toastEl = document.getElementById("toast");
  const toastMsgEl = document.getElementById("toastMsg");
  const toastUndoBtn = document.getElementById("toastUndoBtn");
  const announcerEl = document.getElementById("announcer");

  const ICON_CLOSE =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>';
  const ICON_PLUS =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>';
  const ICON_DUPLICATE =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" /></svg>';
  const ICON_FILTER =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5V8.5z" /></svg>';

  /** Shortcut modifier as the platform names it. */
  const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

  function announce(message) {
    announcerEl.textContent = "";
    // A fresh text node makes screen readers repeat identical messages.
    requestAnimationFrame(() => {
      announcerEl.textContent = message;
    });
  }

  /**
   * Each canvas node is one DQL query block.
   * Parameters are $variables only.
   * Filters are separate groups (AND/OR) on the root or on object edges.
   * @typedef {{ id: string, name: string, type: string, value: string, mode: "var"|"default" }} Param
   * @typedef {{
   *   id: string, func: string, predicate: string,
   *   valueMode: "literal"|"param", literal: string, paramName: string
   * }} FilterCond
   * @typedef {{ op: "AND"|"OR", conditions: FilterCond[] }} FilterGroup
   * @typedef {{
   *   id: string, type: string, name: string, x: number, y: number,
   *   selection: Record<string, any>, params: Param[],
   *   rootFilter: FilterGroup, edgeFilters: Record<string, FilterGroup>,
   *   varName: string, rootVar: string
   * }} QueryNode
   * varName: when set, the block is `varName as var(...)` and is not returned.
   * rootVar: when set, the block starts from `uid(rootVar)` instead of its type.
   * Blocks linked through variables are generated into one operation.
   * @type {QueryNode[]}
   */
  let nodes = [];
  let dragPaletteType = null;
  /** @type {{ id: string, offsetX: number, offsetY: number } | null} */
  let moveState = null;
  /** @type {{ id: string, startX: number, startY: number, startW: number, startH: number } | null} */
  let resizeState = null;
  let selectedNodeId = null;
  let nodeSeq = 0;
  let paramSeq = 0;
  let filterSeq = 0;
  /** True when `schema` came from the built-in sample (reload picks up schema.js edits). */
  let schemaIsSample = true;

  /* ---------- Dev workspace persistence (survives Vite live reload) ---------- */

  const WORKSPACE_KEY = "dql-builder:workspace:v1";
  let saveWorkspaceTimer = null;

  function saveWorkspace() {
    try {
      sessionStorage.setItem(
        WORKSPACE_KEY,
        JSON.stringify({
          schemaIsSample,
          schema: schemaIsSample ? null : schema,
          nodes,
          selectedNodeId,
          nodeSeq,
          paramSeq,
          filterSeq,
        })
      );
    } catch {
      /* quota / private mode */
    }
  }

  function scheduleSaveWorkspace() {
    clearTimeout(saveWorkspaceTimer);
    saveWorkspaceTimer = setTimeout(saveWorkspace, 120);
  }

  function clearWorkspace() {
    clearTimeout(saveWorkspaceTimer);
    try {
      sessionStorage.removeItem(WORKSPACE_KEY);
    } catch {
      /* ignore */
    }
  }

  /* ---------- Undo / redo ---------- */

  /**
   * History holds whole-canvas snapshots. Changes are committed a moment
   * after they settle, so a burst of typing is one step. The schema is kept
   * by reference: switching schema is undoable without copying it each time.
   * @typedef {{ nodes: string, schema: object, schemaIsSample: boolean, selectedNodeId: string|null }} Snapshot
   */
  const HISTORY_LIMIT = 100;
  /** @type {Snapshot[]} */
  const undoStack = [];
  /** @type {Snapshot[]} */
  const redoStack = [];
  /** @type {Snapshot|null} */
  let committed = null;
  let historyTimer = null;
  /** Counts committed steps (the stack length stops growing at the limit). */
  let historySeq = 0;

  function takeSnapshot() {
    return {
      nodes: JSON.stringify(nodes),
      schema,
      schemaIsSample,
      selectedNodeId,
    };
  }

  function sameSnapshot(a, b) {
    return !!a && !!b && a.nodes === b.nodes && a.schema === b.schema;
  }

  function updateHistoryButtons() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }

  /** Record the current canvas as a step if it changed since the last one. */
  function commitHistory() {
    clearTimeout(historyTimer);
    const now = takeSnapshot();
    if (!committed) {
      committed = now;
      return;
    }
    if (sameSnapshot(now, committed)) {
      committed.selectedNodeId = now.selectedNodeId;
      return;
    }
    undoStack.push(committed);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    committed = now;
    historySeq += 1;
    updateHistoryButtons();
    if (toastStep !== null && toastStep !== historySeq) hideToast();
  }

  function scheduleHistoryCommit() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(commitHistory, 500);
  }

  function restoreSnapshot(snap) {
    const schemaChanged = snap.schema !== schema;
    schema = snap.schema;
    schemaIsSample = snap.schemaIsSample;
    nodes = JSON.parse(snap.nodes);
    selectedNodeId = nodes.some((n) => n.id === snap.selectedNodeId) ? snap.selectedNodeId : null;
    committed = snap;
    if (schemaChanged) renderDock();
    renderNodes();
    refreshQuery();
    updateHistoryButtons();
  }

  function undo() {
    commitHistory();
    hideToast();
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(committed);
    restoreSnapshot(prev);
    announce("Undone");
  }

  function redo() {
    commitHistory();
    hideToast();
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(committed);
    restoreSnapshot(next);
    announce("Redone");
  }

  /* ---------- Toast ---------- */

  let toastTimer = null;
  /** History step the toast's change was committed as; a later change hides the toast. */
  let toastStep = null;

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
    toastStep = null;
  }

  function armToastTimer() {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }

  /** Call before a destructive change, so pending typing stays its own step. */
  function checkpoint() {
    commitHistory();
  }

  /** "1 block that used it starts" / "2 blocks that used it start" */
  function usersPhrase(count) {
    return count === 1
      ? "1 block that used it starts from all nodes again"
      : `${count} blocks that used it start from all nodes again`;
  }

  /** Commit the change that just happened and offer to undo it. */
  function showUndoToast(message) {
    commitHistory();
    toastMsgEl.textContent = message;
    toastEl.hidden = false;
    toastStep = historySeq;
    armToastTimer();
    announce(`${message}. Press ${MOD_KEY}+Z to undo.`);
  }

  toastUndoBtn.querySelector("kbd").textContent = `${MOD_KEY}+Z`;
  toastUndoBtn.addEventListener("click", undo);
  // Hold the toast while the pointer or focus is on it.
  toastEl.addEventListener("pointerenter", () => clearTimeout(toastTimer));
  toastEl.addEventListener("pointerleave", armToastTimer);
  toastEl.addEventListener("focusin", () => clearTimeout(toastTimer));
  toastEl.addEventListener("focusout", armToastTimer);
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  undoBtn.title = `Undo (${MOD_KEY}+Z)`;
  redoBtn.title = `Redo (${MOD_KEY}+Shift+Z)`;

  function isTextEntry(el) {
    if (!el) return false;
    if (el.closest?.(".monaco-editor")) return true;
    if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
    return el.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(el.type);
  }

  // Text fields keep their own undo; everywhere else Ctrl+Z undoes canvas changes.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    if (isTextEntry(e.target)) return;
    e.preventDefault();
    if (key === "y" || e.shiftKey) redo();
    else undo();
  });

  function restoreWorkspace() {
    try {
      const raw = sessionStorage.getItem(WORKSPACE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.nodes)) return false;

      if (data.schemaIsSample) {
        schema = window.DQL_SCHEMA;
        schemaIsSample = true;
      } else if (data.schema && typeof data.schema === "object") {
        schema = data.schema;
        schemaIsSample = false;
      } else {
        return false;
      }

      nodes = data.nodes.map((n) => migrateNode({ ...n }));
      selectedNodeId = data.selectedNodeId || null;
      nodeSeq = Number(data.nodeSeq) || nodes.length;
      paramSeq = Number(data.paramSeq) || 0;
      filterSeq = Number(data.filterSeq) || 0;
      nodes.forEach((n) => {
        (n.rootFilter?.conditions || []).forEach((c) => {
          if (!c.id) c.id = filterUid();
        });
        Object.values(n.edgeFilters || {}).forEach((g) => {
          (g.conditions || []).forEach((c) => {
            if (!c.id) c.id = filterUid();
          });
        });
      });
      resolveOverlaps();
      return true;
    } catch {
      return false;
    }
  }

  /* ---------- Output (Monaco with textarea fallback) ---------- */

  let dqlEditor = null;
  let varsEditor = null;
  let dqlFallback = null;
  let varsFallback = null;
  let queryText = "";
  let varsText = "";
  /** True while the user has unsaved edits in the DQL editor. */
  let dqlDirty = false;
  /** Suppress dirty-flag while we push generated text into the editor. */
  let writingDql = false;

  function getDqlText() {
    if (dqlEditor) return dqlEditor.getValue();
    if (dqlFallback) return dqlFallback.value;
    return queryText;
  }

  function updateDqlChrome() {
    const dirty = dqlDirty;
    dqlDirtyBadge.hidden = !dirty;
    dqlEditHint.hidden = !dirty;
    applyDqlBtn.hidden = !dirty;
    revertDqlBtn.hidden = !dirty;
    document.getElementById("dqlEditor")?.classList.toggle("is-dirty", dirty);
  }

  function markDqlDirty() {
    if (writingDql) return;
    if (!dqlDirty) {
      dqlDirty = true;
      updateDqlChrome();
    }
    copyBtn.disabled = !getDqlText().trim();
  }

  function clearDqlDirty() {
    dqlDirty = false;
    updateDqlChrome();
  }

  function writeDqlEditor(value) {
    markDqlError(null);
    writingDql = true;
    try {
      if (dqlEditor) dqlEditor.setValue(value);
      else if (dqlFallback) dqlFallback.value = value;
    } finally {
      writingDql = false;
    }
  }

  function looksLikeDql(text) {
    return /\bquery\s+[A-Za-z_][A-Za-z0-9_]*/i.test(String(text || ""));
  }

  /* ---------- Builder console ---------- */

  /** @type {{ id: number, level: 'error'|'warn'|'info', message: string, source: string, time: number }[]} */
  const consoleEntries = [];
  let consoleSeq = 0;

  function applyConsoleFilters() {
    const level = consoleLevelEl.value || "all";
    consoleOutputEl.querySelectorAll(".console-row").forEach((row) => {
      row.classList.toggle("is-hidden", level !== "all" && row.dataset.level !== level);
    });
  }

  function updateConsoleCounts() {
    const errors = consoleEntries.filter((e) => e.level === "error").length;
    const warns = consoleEntries.filter((e) => e.level === "warn").length;
    consoleErrorCountEl.textContent = String(errors);
    consoleErrorCountEl.hidden = !errors;
    consoleErrorCountEl.title = `${errors} error${errors === 1 ? "" : "s"}`;
    consoleWarnCountEl.textContent = String(warns);
    consoleWarnCountEl.hidden = !warns;
    consoleWarnCountEl.title = `${warns} warning${warns === 1 ? "" : "s"}`;
  }

  function setConsoleOpen(open) {
    consoleOutputEl.hidden = !open;
    consoleToolsEl.hidden = !open;
    consoleLastEl.hidden = open;
    consoleToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
  }

  function renderConsoleEmpty() {
    if (consoleEntries.length) return;
    consoleOutputEl.innerHTML =
      '<p class="console-empty">No messages. Parse and build messages appear here.</p>';
    consoleLastEl.textContent = "";
  }

  function clearConsole() {
    consoleEntries.length = 0;
    consoleOutputEl.innerHTML = "";
    updateConsoleCounts();
    renderConsoleEmpty();
  }

  /**
   * @param {'error'|'warn'|'info'} level
   * @param {string} message
   * @param {string} [source]
   */
  function consoleLog(level, message, source = "builder") {
    const entry = {
      id: ++consoleSeq,
      level,
      message: String(message || ""),
      source: String(source || "builder"),
      time: Date.now(),
    };
    consoleEntries.push(entry);

    const empty = consoleOutputEl.querySelector(".console-empty");
    if (empty) empty.remove();

    const row = document.createElement("div");
    row.className = `console-row is-${entry.level}`;
    row.dataset.level = entry.level;
    row.innerHTML = `
      <span class="console-row-level"></span>
      <span class="console-row-msg"></span>
      <span class="console-row-source"></span>
    `;
    row.querySelector(".console-row-level").textContent = entry.level;
    row.querySelector(".console-row-msg").textContent = entry.message;
    row.querySelector(".console-row-source").textContent = entry.source;
    consoleOutputEl.appendChild(row);
    consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
    consoleLastEl.textContent = entry.message;

    updateConsoleCounts();
    applyConsoleFilters();
    // Errors need attention — surface them instead of hiding in a collapsed bar.
    if (entry.level === "error") setConsoleOpen(true);
  }

  function consoleError(message, source) {
    consoleLog("error", message, source);
  }

  function consoleWarn(message, source) {
    consoleLog("warn", message, source);
  }

  function consoleInfo(message, source) {
    consoleLog("info", message, source);
  }

  consoleClearBtn.addEventListener("click", clearConsole);
  consoleLevelEl.addEventListener("change", applyConsoleFilters);
  consoleToggleBtn.addEventListener("click", () => setConsoleOpen(consoleOutputEl.hidden));
  renderConsoleEmpty();

  function setOutputs(dql, vars) {
    queryText = dql;
    varsText = vars;
    // Canvas → editor only while the DQL buffer is clean.
    if (!dqlDirty) writeDqlEditor(dql);
    if (varsEditor) varsEditor.setValue(vars);
    else if (varsFallback) varsFallback.value = vars;
    copyBtn.disabled = !(dqlDirty ? getDqlText().trim() : dql);
    copyVarsBtn.disabled = !vars;
  }

  function makeFallbackTextarea(hostId, { readOnly = true } = {}) {
    const host = document.getElementById(hostId);
    const ta = document.createElement("textarea");
    ta.readOnly = readOnly;
    ta.spellcheck = false;
    ta.style.cssText =
      "width:100%;height:100%;border:none;outline:none;resize:none;padding:1rem;" +
      "font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--text);background:transparent;";
    host.appendChild(ta);
    return ta;
  }

  /** Plain textareas when Monaco can't load (offline, CDN blocked). */
  function useFallbackEditors(reason) {
    if (dqlFallback || dqlEditor) return;
    consoleWarn(`${reason} Using a plain text editor without highlighting.`, "editor");
    dqlFallback = makeFallbackTextarea("dqlEditor", { readOnly: false });
    varsFallback = makeFallbackTextarea("varsEditor", { readOnly: true });
    dqlFallback.addEventListener("input", () => markDqlDirty());
    dqlFallback.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        applyDqlFromEditor({ reason: "shortcut" });
      }
    });
    dqlFallback.addEventListener("blur", () => {
      applyDqlFromEditor({ reason: "blur", soft: true });
    });
    setOutputs(queryText, varsText);
  }

  function initEditors() {
    if (!window.require) {
      useFallbackEditors("The code editor could not load (offline or blocked CDN).");
      return;
    }

    window.require.config({
      paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" },
    });

    window.require(["vs/editor/editor.main"], () => {
      // One quiet color for all bracket levels instead of a rainbow.
      const brackets = (color) =>
        Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`editorBracketHighlight.foreground${i}`, color]));

      monaco.editor.defineTheme("dql-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "keyword", foreground: "3dd68c" },
          { token: "string", foreground: "f2c94c" },
          { token: "number", foreground: "8ab4f8" },
          { token: "comment", foreground: "90939c", fontStyle: "italic" },
        ],
        colors: {
          "editor.background": "#1a1b1f",
          "editor.foreground": "#e4e5e9",
          "editor.lineHighlightBackground": "#212227",
          "editor.lineHighlightBorder": "#00000000",
          "editorLineNumber.foreground": "#4a4d55",
          "editorLineNumber.activeForeground": "#9a9ca5",
          "editorGutter.background": "#1a1b1f",
          "editorCursor.foreground": "#e4e5e9",
          "editor.selectionBackground": "#3b3e46",
          "editor.inactiveSelectionBackground": "#2a2c32",
          "editorIndentGuide.background1": "#2c2e34",
          "editorWidget.background": "#212227",
          "editorWidget.border": "#3b3e46",
          "input.background": "#111215",
          "dropdown.background": "#212227",
          "scrollbarSlider.background": "#3b3e4680",
          "scrollbarSlider.hoverBackground": "#3b3e46",
          ...brackets("#9a9ca5"),
        },
      });

      monaco.editor.defineTheme("dql-light", {
        base: "vs",
        inherit: true,
        rules: [
          { token: "keyword", foreground: "15803d" },
          { token: "string", foreground: "a15c00" },
          { token: "number", foreground: "1d5fc2" },
          { token: "comment", foreground: "686d77", fontStyle: "italic" },
        ],
        colors: {
          "editor.background": "#ffffff",
          "editor.foreground": "#1c1e23",
          "editor.lineHighlightBackground": "#f7f8fa",
          "editor.lineHighlightBorder": "#00000000",
          "editorLineNumber.foreground": "#b4b8c0",
          "editorLineNumber.activeForeground": "#5d626d",
          "editorGutter.background": "#ffffff",
          "editorCursor.foreground": "#1c1e23",
          "editor.selectionBackground": "#d9dde4",
          "editor.inactiveSelectionBackground": "#eceef2",
          "editorIndentGuide.background1": "#e2e4e9",
          "editorWidget.background": "#ffffff",
          "editorWidget.border": "#cfd3da",
          "input.background": "#ffffff",
          "dropdown.background": "#ffffff",
          "scrollbarSlider.background": "#cfd3da80",
          "scrollbarSlider.hoverBackground": "#cfd3da",
          ...brackets("#5d626d"),
        },
      });

      const common = {
        theme: monacoThemeName(),
        minimap: { enabled: false },
        automaticLayout: true,
        fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 12, bottom: 12 },
        wordWrap: "on",
        guides: { indentation: false },
      };

      // GraphQL grammar is the closest built-in match for DQL.
      dqlEditor = monaco.editor.create(document.getElementById("dqlEditor"), {
        ...common,
        readOnly: false,
        value: queryText,
        language: "graphql",
        contextmenu: true,
        ariaLabel: "DQL editor",
      });
      varsEditor = monaco.editor.create(document.getElementById("varsEditor"), {
        ...common,
        readOnly: true,
        value: varsText,
        language: "json",
        lineNumbers: "off",
        contextmenu: false,
        renderLineHighlight: "none",
      });

      dqlEditor.onDidChangeModelContent(() => {
        if (!writingDql) markDqlDirty();
      });

      dqlEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        applyDqlFromEditor({ reason: "shortcut" });
      });

      dqlEditor.onDidBlurEditorWidget(() => {
        // Defer so a click on Apply/Revert is processed first.
        setTimeout(() => {
          if (document.activeElement?.closest?.("#applyDqlBtn, #revertDqlBtn")) return;
          applyDqlFromEditor({ reason: "blur", soft: true });
        }, 0);
      });
    }, () => useFallbackEditors("The code editor could not load (offline or blocked CDN)."));
  }

  /** Point at a parse error in the editor; no error clears the marker. */
  function markDqlError(err) {
    if (!dqlEditor || typeof monaco === "undefined") return;
    const model = dqlEditor.getModel();
    if (!err?.line) {
      monaco.editor.setModelMarkers(model, "dql", []);
      return;
    }
    const line = Math.min(err.line, model.getLineCount());
    const column = Math.max(1, err.column || 1);
    const word = model.getWordAtPosition({ lineNumber: line, column });
    monaco.editor.setModelMarkers(model, "dql", [
      {
        severity: monaco.MarkerSeverity.Error,
        message: String(err.message || err),
        startLineNumber: line,
        startColumn: word ? word.startColumn : column,
        endLineNumber: line,
        endColumn: word ? word.endColumn : column + 1,
      },
    ]);
  }

  /* ---------- Helpers ---------- */

  function uid() {
    nodeSeq += 1;
    return `node-${nodeSeq}`;
  }

  function paramUid() {
    paramSeq += 1;
    return `param-${paramSeq}`;
  }

  function filterUid() {
    filterSeq += 1;
    return `filter-${filterSeq}`;
  }

  function emptyFilterGroup(op = "AND") {
    return { op: op === "OR" ? "OR" : "AND", conditions: [] };
  }

  /** New conditions start without a value; they stay out of the query until filled in. */
  function newFilterCondition(predicate = "") {
    return {
      id: filterUid(),
      func: "eq",
      predicate,
      valueMode: "literal",
      literal: "",
      paramName: "",
    };
  }

  function ensureFilterGroup(group) {
    if (!group || typeof group !== "object") return emptyFilterGroup();
    return {
      op: group.op === "OR" ? "OR" : "AND",
      conditions: Array.isArray(group.conditions) ? group.conditions : [],
    };
  }

  /** Migrate legacy param-bound filters → rootFilter / edgeFilters. */
  function migrateNode(node) {
    if (!node.rootFilter) node.rootFilter = emptyFilterGroup();
    else node.rootFilter = ensureFilterGroup(node.rootFilter);
    if (!node.edgeFilters || typeof node.edgeFilters !== "object") node.edgeFilters = {};

    const legacy = [];
    const kept = [];
    (node.params || []).forEach((p) => {
      if (p && p.func && p.predicate) legacy.push(p);
      else if (p) {
        kept.push({
          id: p.id || paramUid(),
          name: p.name,
          type: PARAM_TYPES.includes(p.type) ? p.type : "string",
          value: p.value ?? "",
          mode: p.mode === "default" ? "default" : "var",
        });
      }
    });

    legacy.forEach((p) => {
      const walk = splitPredicatePath(node.type, p.predicate) || {
        edgeParts: [],
        leaf: p.predicate,
        edgePath: "",
      };
      const unary = isUnaryFilter(p.func);
      const cond = {
        id: filterUid(),
        func: p.func,
        predicate: walk.leaf,
        valueMode: p.mode === "literal" || unary ? "literal" : "param",
        literal: p.mode === "literal" ? String(p.value ?? "") : "",
        paramName: p.mode === "literal" || unary ? "" : p.name,
      };
      if (!walk.edgePath) {
        node.rootFilter.conditions.push(cond);
      } else {
        if (!node.edgeFilters[walk.edgePath]) {
          node.edgeFilters[walk.edgePath] = emptyFilterGroup();
        }
        node.edgeFilters[walk.edgePath].conditions.push(cond);
      }
      if (!unary && p.mode !== "literal") {
        if (!kept.some((k) => k.name === p.name)) {
          kept.push({
            id: p.id || paramUid(),
            name: p.name,
            type: PARAM_TYPES.includes(p.type) ? p.type : "string",
            value: p.value ?? "",
            mode: p.mode === "default" ? "default" : "var",
          });
        }
      }
    });

    node.params = kept;
    if (typeof node.varName !== "string") node.varName = "";
    if (typeof node.rootVar !== "string") node.rootVar = "";
    if (node.width != null) node.width = Math.max(300, Number(node.width) || 380);
    if (node.height != null) node.height = Math.max(240, Number(node.height) || 520);
    return node;
  }

  function typeAtEdgePath(rootType, edgePath) {
    if (!edgePath) return rootType;
    const walk = splitPredicatePath(rootType, edgePath);
    if (!walk) return rootType;
    let typeName = rootType;
    for (const edge of walk.edgeParts) {
      const field = (schema[typeName]?.fields || []).find((f) => f.name === edge);
      if (!field?.ofType) return typeName;
      typeName = field.ofType;
    }
    const leaf = (schema[typeName]?.fields || []).find((f) => f.name === walk.leaf);
    return leaf?.ofType || typeName;
  }

  function fieldDisplayName(name) {
    const raw = String(name || "");
    const i = raw.lastIndexOf(".");
    return i >= 0 ? raw.slice(i + 1) : raw;
  }

  function scalarOptionsForType(typeName) {
    return scalarPredicates(typeName).map((f) => ({
      value: f.name,
      label: fieldDisplayName(f.name),
    }));
  }

  function defaultName(typeName) {
    const base = `get${typeName}`;
    if (!nodes.some((n) => n.name === base)) return base;
    let i = 2;
    while (nodes.some((n) => n.name === `${base}${i}`)) i += 1;
    return `${base}${i}`;
  }

  function sanitizeName(raw, fallback) {
    let name = String(raw || "")
      .trim()
      .replace(/^\$/, "")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/^([^A-Za-z_])/, "_$1");
    if (!name) name = fallback;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) name = fallback;
    return name;
  }

  function defaultSelection(typeName) {
    const def = schema[typeName];
    const selection = {};
    def.fields
      .filter((f) => f.kind === "scalar")
      .slice(0, 2)
      .forEach((f) => {
        selection[f.name] = null;
      });
    return selection;
  }

  function scalarPredicates(typeName) {
    return (schema[typeName]?.fields || []).filter(
      (f) => f.kind === "scalar" && f.name !== "uid"
    );
  }

  function defaultParamValue(type) {
    if (type === "int" || type === "float") return "0";
    if (type === "bool") return "false";
    return "";
  }

  /** Resolve a predicate path to its schema field, respecting dotted field names. */
  function resolvePredicateField(typeName, pathStr) {
    const walk = splitPredicatePath(typeName, pathStr);
    if (!walk) return null;
    let currentType = typeName;
    for (const edge of walk.edgeParts) {
      const field = (schema[currentType]?.fields || []).find((f) => f.name === edge);
      if (!field?.ofType) return null;
      currentType = field.ofType;
    }
    return (schema[currentType]?.fields || []).find((f) => f.name === walk.leaf) || null;
  }

  /**
   * Split "posts.published" or a namespaced "User.email" into edge parts + leaf,
   * matching longest field names on the schema at each step.
   */
  function splitPredicatePath(typeName, pathStr) {
    const raw = String(pathStr || "");
    if (!raw) return null;

    const fieldsAt = (t) => schema[t]?.fields || [];
    if (fieldsAt(typeName).some((f) => f.name === raw)) {
      return { edgeParts: [], leaf: raw, edgePath: "" };
    }

    const segments = raw.split(".");
    const edgeParts = [];
    let currentType = typeName;
    let i = 0;

    while (i < segments.length) {
      const fields = fieldsAt(currentType);
      let matched = null;
      let matchedEnd = -1;
      for (let j = segments.length; j > i; j -= 1) {
        const candidate = segments.slice(i, j).join(".");
        const field = fields.find((f) => f.name === candidate);
        if (field) {
          matched = field;
          matchedEnd = j;
          break;
        }
      }

      if (!matched) {
        return {
          edgeParts,
          leaf: segments.slice(i).join("."),
          edgePath: edgeParts.join("."),
        };
      }

      const start = i;
      i = matchedEnd;

      if (i >= segments.length) {
        return { edgeParts, leaf: matched.name, edgePath: edgeParts.join(".") };
      }

      if (matched.kind === "object" && matched.ofType) {
        edgeParts.push(matched.name);
        currentType = matched.ofType;
        continue;
      }

      // Scalar matched but path continues — keep the unmatched remainder as one leaf.
      return {
        edgeParts,
        leaf: segments.slice(start).join("."),
        edgePath: edgeParts.join("."),
      };
    }

    return null;
  }

  function paramTypeForPredicate(typeName, predicate) {
    const field = resolvePredicateField(typeName, predicate);
    return PARAM_TYPES.includes(field?.type) ? field.type : "string";
  }

  /**
   * Filter targets for a block: its own scalar predicates plus, for every
   * expanded object edge, the nested type's scalars as dotted paths
   * ("posts.published"). Nested targets produce an @filter on that edge.
   */
  function filterTargets(typeName, selection, prefix = []) {
    let targets = scalarPredicates(typeName).map((f) => {
      const parts = [...prefix, f.name];
      return {
        value: parts.join("."),
        label: parts.map(fieldDisplayName).join("."),
      };
    });

    if (prefix.length >= 6) return targets;

    (schema[typeName]?.fields || [])
      .filter(
        (f) =>
          f.kind === "object" &&
          f.ofType &&
          schema[f.ofType] &&
          selection &&
          typeof selection[f.name] === "object" &&
          selection[f.name] !== null
      )
      .forEach((f) => {
        targets = targets.concat(
          filterTargets(f.ofType, selection[f.name], [...prefix, f.name])
        );
      });

    return targets;
  }

  function getAtPath(selection, path) {
    let cursor = selection;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
      cursor = cursor[key];
    }
    return cursor;
  }

  function setAtPath(selection, path, value) {
    if (path.length === 0) return value;
    const [head, ...rest] = path;
    const next = { ...selection };
    if (rest.length === 0) {
      if (value === undefined) delete next[head];
      else next[head] = value;
      return next;
    }
    const child =
      next[head] && typeof next[head] === "object" ? { ...next[head] } : {};
    next[head] = setAtPath(child, rest, value);
    return next;
  }

  function isSelected(selection, path) {
    return getAtPath(selection, path) !== undefined;
  }

  /** Encode a field-name path for data attributes (names may contain dots). */
  function encodePath(path) {
    return JSON.stringify(path);
  }

  function decodePath(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* legacy dotted paths */
    }
    return String(raw || "").split(".").filter((p) => p.length);
  }

  function pathKey(path) {
    return path.join(".");
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function updateEmptyState() {
    canvasEmptyEl.hidden = nodes.length > 0;
    blockCountEl.textContent = nodes.length
      ? `${nodes.length} block${nodes.length === 1 ? "" : "s"}`
      : "";
    clearBtn.disabled = !nodes.length;
  }

  function updateSchemaLabel() {
    const count = Object.keys(schema || {}).length;
    const source = schemaIsSample ? "Sample schema" : "Custom schema";
    schemaLabelEl.textContent = `${source} · ${count} entit${count === 1 ? "y" : "ies"}`;
  }

  /** Lift dark schema colors so the type dot stays visible on dark surfaces. */
  function dotColor(color) {
    return `color-mix(in srgb, ${color || "#888"} 75%, var(--dot-mix))`;
  }

  function stopDragPropagation(el) {
    ["pointerdown", "mousedown", "click"].forEach((evt) => {
      el.addEventListener(evt, (e) => e.stopPropagation());
    });
  }

  function getNode(id) {
    return nodes.find((n) => n.id === id);
  }

  /* ---------- Query variables (blocks linked by `name as var` / `uid(name)`) ---------- */

  function filterGroupsOf(node) {
    return [node.rootFilter, ...Object.values(node.edgeFilters || {})].filter(Boolean);
  }

  function varDefiner(name) {
    return name ? nodes.find((n) => n.varName === name) : null;
  }

  /** Variable names a block reads: where it starts from plus uid() filters anywhere in it. */
  function varRefs(node) {
    const refs = new Set();
    if (node.rootVar) refs.add(node.rootVar);
    filterGroupsOf(node).forEach((g) =>
      (g.conditions || []).forEach((c) => {
        if (isVarFilter(c.func) && c.varRef) refs.add(c.varRef);
      })
    );
    return [...refs];
  }

  function variableUsers(node) {
    if (!node.varName) return [];
    return nodes.filter((n) => n.id !== node.id && varRefs(n).includes(node.varName));
  }

  /** True when `node` reading `name` would form a loop back to itself. */
  function createsCycle(node, name) {
    const seen = new Set();
    const stack = [name];
    while (stack.length) {
      const def = varDefiner(stack.pop());
      if (!def || seen.has(def.id)) continue;
      if (def.id === node.id) return true;
      seen.add(def.id);
      stack.push(...varRefs(def));
    }
    return false;
  }

  /** Variables of `typeName` that `node` can read without creating a loop. */
  function usableVars(node, typeName) {
    return nodes
      .filter((d) => d.varName && d.id !== node.id && d.type === typeName && !createsCycle(node, d.varName))
      .map((d) => d.varName);
  }

  function uniqueVarName(seed, exceptId) {
    const base = sanitizeName(seed, "ids");
    let name = base;
    let i = 2;
    while (nodes.some((n) => n.id !== exceptId && n.varName === name)) {
      name = `${base}${i}`;
      i += 1;
    }
    return name;
  }

  function renameVarRefs(prev, next) {
    nodes.forEach((n) => {
      if (n.rootVar === prev) n.rootVar = next;
      filterGroupsOf(n).forEach((g) =>
        (g.conditions || []).forEach((c) => {
          if (isVarFilter(c.func) && c.varRef === prev) c.varRef = next;
        })
      );
    });
  }

  /** Remove every use of a variable: blocks start from their type again and uid() filters go. */
  function dropVarRefs(name) {
    nodes.forEach((n) => {
      if (n.rootVar === name) n.rootVar = "";
      if (n.rootFilter) {
        n.rootFilter.conditions = n.rootFilter.conditions.filter(
          (c) => !(isVarFilter(c.func) && c.varRef === name)
        );
      }
      Object.entries(n.edgeFilters || {}).forEach(([key, g]) => {
        g.conditions = (g.conditions || []).filter((c) => !(isVarFilter(c.func) && c.varRef === name));
        if (!g.conditions.length) delete n.edgeFilters[key];
      });
    });
  }

  /** Arrows from each variable block to the blocks that read it. */
  function drawLinks() {
    const paths = [];
    nodes.forEach((to) => {
      varRefs(to).forEach((name) => {
        const from = varDefiner(name);
        if (!from || from.id === to.id) return;
        const a = canvasEl.querySelector(`.entity-node[data-id="${from.id}"]`);
        const b = canvasEl.querySelector(`.entity-node[data-id="${to.id}"]`);
        if (!a || !b) return;
        const forward = b.offsetLeft + b.offsetWidth / 2 >= a.offsetLeft + a.offsetWidth / 2;
        const x1 = forward ? a.offsetLeft + a.offsetWidth : a.offsetLeft;
        const x2 = forward ? b.offsetLeft : b.offsetLeft + b.offsetWidth;
        // Anchor on the header row so links stay put while blocks scroll.
        const y1 = a.offsetTop + 18;
        const y2 = b.offsetTop + 18;
        const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
        // The label is a small tag on the curve's midpoint; 6.6px per mono char at 11px.
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const labelW = Math.round(name.length * 6.6 + 14);
        paths.push(`
          <g class="link" data-from="${from.id}" data-to="${to.id}">
            <path class="link-path" d="M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#link-arrow)" />
            <circle class="link-port" cx="${x1}" cy="${y1}" r="4" />
            <g class="link-label">
              <rect x="${mx - labelW / 2}" y="${my - 10}" width="${labelW}" height="20" rx="10" />
              <text x="${mx}" y="${my}">${escapeAttr(name)}</text>
            </g>
          </g>
        `);
      });
    });
    canvasSurfaceEl.innerHTML = paths.length
      ? `<svg class="links" width="100%" height="100%">
          <defs>
            <marker id="link-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L8 4L0 8z" />
            </marker>
          </defs>
          ${paths.join("")}
        </svg>`
      : "";
    if (activeLinkNode) highlightLinks(activeLinkNode);
  }

  /** Block the pointer or focus is on; its links and linked blocks stand out. */
  let activeLinkNode = null;

  function highlightLinks(id) {
    activeLinkNode = id;
    const svg = canvasSurfaceEl.querySelector(".links");
    const linked = new Set();
    svg?.querySelectorAll(".link").forEach((link) => {
      const active = !!id && (link.dataset.from === id || link.dataset.to === id);
      link.classList.toggle("is-active", active);
      if (active) linked.add(link.dataset.from === id ? link.dataset.to : link.dataset.from);
    });
    svg?.classList.toggle("has-active", linked.size > 0);
    canvasEl.querySelectorAll(".entity-node").forEach((el) => {
      el.classList.toggle("is-linked", linked.has(el.dataset.id));
    });
  }

  function setSelected(id) {
    selectedNodeId = id;
    canvasEl.querySelectorAll(".entity-node").forEach((nodeEl) => {
      nodeEl.classList.toggle("selected", nodeEl.dataset.id === id);
      nodeEl.style.zIndex = nodeEl.dataset.id === id ? "5" : "2";
    });
  }

  /* ---------- Entity menu (canvas header) ---------- */

  const DEFAULT_NODE_W = 420;
  const DEFAULT_NODE_H = 520;
  const NODE_GAP = 56;
  const CANVAS_PAD = 48;
  /** Room past the farthest block, so there is always space to drag into. */
  const CANVAS_MARGIN = 240;

  function estimateNodeSize(node) {
    return {
      w: Math.max(300, Number(node.width) || DEFAULT_NODE_W),
      h: Math.max(220, Number(node.height) || DEFAULT_NODE_H),
    };
  }

  function rectsOverlap(a, b, gap = NODE_GAP) {
    return !(
      a.x + a.w + gap <= b.x ||
      b.x + b.w + gap <= a.x ||
      a.y + a.h + gap <= b.y ||
      b.y + b.h + gap <= a.y
    );
  }

  function findFreePosition(width, height, preferred, excludeId) {
    const w = width || DEFAULT_NODE_W;
    const h = height || DEFAULT_NODE_H;
    const others = nodes
      .filter((n) => n.id !== excludeId)
      .map((n) => {
        const s = estimateNodeSize(n);
        return { x: n.x, y: n.y, w: s.w, h: s.h };
      });

    const tryPos = (x, y) => {
      const cand = { x: Math.max(CANVAS_PAD, x), y: Math.max(CANVAS_PAD, y), w, h };
      if (!others.some((o) => rectsOverlap(cand, o))) return cand;
      return null;
    };

    if (preferred) {
      const hit = tryPos(preferred.x, preferred.y);
      if (hit) return hit;
    }

    // Scan a grid across a generous canvas.
    const stepX = Math.floor(w + NODE_GAP);
    const stepY = Math.floor(Math.min(h, 280) + NODE_GAP);
    for (let row = 0; row < 40; row += 1) {
      for (let col = 0; col < 24; col += 1) {
        const hit = tryPos(CANVAS_PAD + col * stepX, CANVAS_PAD + row * stepY);
        if (hit) return hit;
      }
    }
    return {
      x: CANVAS_PAD + nodes.length * 24,
      y: CANVAS_PAD + nodes.length * 24,
      w,
      h,
    };
  }

  /** Push overlapping cards onto free slots (session restore / imports). */
  function resolveOverlaps() {
    nodes.forEach((n) => {
      const s = estimateNodeSize(n);
      const self = { x: n.x, y: n.y, w: s.w, h: s.h };
      const hit = nodes.some((o) => {
        if (o.id === n.id) return false;
        const os = estimateNodeSize(o);
        return rectsOverlap(self, { x: o.x, y: o.y, w: os.w, h: os.h });
      });
      if (!hit) return;
      const pos = findFreePosition(s.w, s.h, null, n.id);
      n.x = pos.x;
      n.y = pos.y;
    });
  }

  /** Size the scroll area to the blocks: no scrollbars until something is out of view. */
  function updateCanvasSurface() {
    if (!canvasSurfaceEl) return;
    let maxR = 0;
    let maxB = 0;
    canvasEl.querySelectorAll(".entity-node").forEach((el) => {
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      maxR = Math.max(maxR, x + el.offsetWidth + CANVAS_MARGIN);
      maxB = Math.max(maxB, y + el.offsetHeight + CANVAS_MARGIN);
    });
    // Never larger than needed: an empty canvas fits its pane exactly.
    const fitsW = maxR <= canvasEl.clientWidth;
    const fitsH = maxB <= canvasEl.clientHeight;
    canvasSurfaceEl.style.width = fitsW ? "100%" : `${Math.ceil(maxR)}px`;
    canvasSurfaceEl.style.height = fitsH ? "100%" : `${Math.ceil(maxB)}px`;
    drawLinks();
  }

  // Blocks change height with their content (tabs, toggles), and the pane resizes.
  const surfaceObserver = new ResizeObserver(() => updateCanvasSurface());
  surfaceObserver.observe(canvasEl);

  function closeEntityMenu() {
    if (entityMenuEl.hidden) return;
    entityMenuEl.hidden = true;
    addEntityBtn.setAttribute("aria-expanded", "false");
  }

  function openEntityMenu() {
    entityMenuEl.hidden = false;
    addEntityBtn.setAttribute("aria-expanded", "true");
    entitySearchEl.value = "";
    renderEntityMenu();
    entitySearchEl.focus();
  }

  function toggleEntityMenu() {
    if (entityMenuEl.hidden) openEntityMenu();
    else closeEntityMenu();
  }

  function renderDock() {
    renderEntityMenu();
    updateSchemaLabel();
  }

  function addEntityFromMenu(typeName) {
    closeEntityMenu();
    const pos = findFreePosition(DEFAULT_NODE_W, DEFAULT_NODE_H);
    placeEntity(typeName, pos.x, pos.y);
    scrollNodeIntoView(selectedNodeId);
  }

  function setActiveMenuItem(item) {
    entityMenuListEl.querySelectorAll(".menu-item").forEach((el) => {
      const active = el === item;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
    });
    item?.scrollIntoView({ block: "nearest" });
  }

  function renderEntityMenu() {
    const q = entitySearchEl.value.trim().toLowerCase();
    entityMenuListEl.innerHTML = "";

    const entries = Object.entries(schema).filter(
      ([typeName]) => !q || typeName.toLowerCase().includes(q)
    );
    if (!entries.length) {
      entityMenuListEl.innerHTML = '<p class="menu-empty">No matching entities</p>';
      return;
    }

    entries.forEach(([typeName, def]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-item";
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.draggable = true;
      item.dataset.type = typeName;
      item.title = "Click to add, or drag onto the canvas";
      const count = def.fields?.length || 0;
      item.innerHTML = `
        <span class="dot" style="background:${dotColor(def.color)}"></span>
        <span class="menu-item-name">${escapeAttr(typeName)}</span>
        <span class="menu-item-meta">${count} field${count === 1 ? "" : "s"}</span>
      `;
      item.addEventListener("click", () => addEntityFromMenu(typeName));
      item.addEventListener("mousemove", () => setActiveMenuItem(item));
      item.addEventListener("dragstart", (e) => {
        dragPaletteType = typeName;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", typeName);
      });
      item.addEventListener("dragend", () => {
        dragPaletteType = null;
      });
      entityMenuListEl.appendChild(item);
    });

    setActiveMenuItem(entityMenuListEl.querySelector(".menu-item"));
  }

  entitySearchEl.addEventListener("input", renderEntityMenu);
  entitySearchEl.addEventListener("keydown", (e) => {
    const items = [...entityMenuListEl.querySelectorAll(".menu-item")];
    const current = items.findIndex((el) => el.classList.contains("is-active"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveMenuItem(items[(current + step + items.length) % items.length]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[current] || items[0];
      if (item) addEntityFromMenu(item.dataset.type);
    } else if (e.key === "Escape") {
      closeEntityMenu();
      addEntityBtn.focus();
    }
  });

  function scrollNodeIntoView(id) {
    const el = id && canvasEl.querySelector(`.entity-node[data-id="${id}"]`);
    if (!el) return;
    const x = el.offsetLeft;
    const y = el.offsetTop;
    const viewL = canvasEl.scrollLeft;
    const viewT = canvasEl.scrollTop;
    const fits =
      x >= viewL &&
      y >= viewT &&
      x + Math.min(el.offsetWidth, canvasEl.clientWidth) <= viewL + canvasEl.clientWidth &&
      y + 40 <= viewT + canvasEl.clientHeight;
    if (!fits) {
      canvasEl.scrollTo({ left: Math.max(0, x - 24), top: Math.max(0, y - 24), behavior: "smooth" });
    }
  }

  /* ---------- Query block rendering ---------- */

  /** Transient per-block field search text (not persisted). */
  const fieldQueries = new Map();

  /** Transient per-block active tab (not persisted). */
  const nodeTabs = new Map();
  const NODE_TABS = [
    { id: "fields", label: "Fields" },
    { id: "filter", label: "Filter" },
    { id: "variables", label: "Variables" },
    { id: "settings", label: "Settings" },
  ];

  function tabCountHtml(count, incomplete) {
    if (!count) return "";
    const warn = incomplete
      ? ` is-warn" title="${incomplete} incomplete condition${incomplete === 1 ? "" : "s"}`
      : "";
    return `<span class="tab-count${warn}">${count}</span>`;
  }

  function renderNodeTabs(node, activeTab) {
    const counts = {
      fields: countSelected(node.selection),
      filter: ensureFilterGroup(node.rootFilter).conditions.length,
      variables: (node.params || []).length,
    };
    const incomplete = countIncomplete(node);
    const warnings = { fields: incomplete.edges, filter: incomplete.root };
    return NODE_TABS.map((tab) => {
      const active = tab.id === activeTab;
      return `
        <button
          type="button"
          class="node-tab"
          role="tab"
          id="${node.id}-tab-${tab.id}"
          data-tab="${tab.id}"
          aria-controls="${node.id}-panel-${tab.id}"
          aria-selected="${active}"
          tabindex="${active ? 0 : -1}"
        >${tab.label}${tabCountHtml(counts[tab.id], warnings[tab.id])}</button>
      `;
    }).join("");
  }

  /** Refresh tab warnings and a condition row's state without a re-render (typing). */
  function updateConditionState(nodeEl, node, row, cond, typeName) {
    const issue = conditionIssue(cond, typeName);
    row.classList.toggle("is-incomplete", !!issue);
    let note = row.querySelector(".filter-issue");
    if (issue && !note) {
      note = document.createElement("p");
      note.className = "filter-issue";
      note.id = `${cond.id}-issue`;
      row.appendChild(note);
    }
    if (note) {
      if (issue) note.textContent = issue;
      else note.remove();
    }
    row.querySelector(".filter-literal")?.setAttribute("aria-invalid", String(!!issue));
    const incomplete = countIncomplete(node);
    const warnings = { fields: incomplete.edges, filter: incomplete.root };
    nodeEl.querySelectorAll(".node-tab").forEach((tab) => {
      const badge = tab.querySelector(".tab-count");
      if (!badge || !(tab.dataset.tab in warnings)) return;
      const n = warnings[tab.dataset.tab];
      badge.classList.toggle("is-warn", !!n);
      if (n) badge.title = `${n} incomplete condition${n === 1 ? "" : "s"}`;
      else badge.removeAttribute("title");
    });
  }

  function nodePanel(node, tabId, activeTab, html) {
    return `
      <div
        class="node-panel"
        role="tabpanel"
        id="${node.id}-panel-${tabId}"
        data-panel="${tabId}"
        aria-labelledby="${node.id}-tab-${tabId}"
        ${tabId === activeTab ? "" : "hidden"}
      >${html}</div>
    `;
  }

  function renderFilterValueControls(cond, node, typeName) {
    const params = node.params;
    if (isVarFilter(cond.func)) {
      const names = usableVars(node, typeName);
      if (cond.varRef && !names.includes(cond.varRef)) names.push(cond.varRef);
      if (!names.length) {
        return `<span class="filter-value-blank" title="Turn on “Use as variable” in a ${escapeAttr(typeName)} block's Settings">No ${escapeAttr(typeName)} variable yet</span>`;
      }
      return `<select class="filter-var-ref" aria-label="Variable">${optionsHtml(
        names.map((name) => ({ value: name, label: name })),
        cond.varRef || ""
      )}</select>`;
    }

    if (isUnaryFilter(cond.func)) {
      return `<span class="filter-value-blank" title="${escapeAttr(cond.func)} takes no value">No value needed</span>`;
    }

    const isParam = cond.valueMode === "param";
    // `$` is DQL's own variable sigil, so the button shows it; the name says what it does.
    const toggle = `
      <button
        type="button"
        class="filter-value-mode"
        aria-pressed="${isParam}"
        aria-label="Use a variable"
        title="${isParam ? "Using a variable. Click to type a value instead." : "Use a variable instead of a value"}"
      >$</button>
    `;

    if (isParam) {
      const paramOpts = (params || []).map((p) => ({ value: p.name, label: `$${p.name}` }));
      return `
        <div class="filter-value">
          ${toggle}
          <select class="filter-param" aria-label="Variable">${optionsHtml(
            paramOpts.length ? paramOpts : [{ value: "", label: "No variables" }],
            cond.paramName || ""
          )}</select>
        </div>
      `;
    }

    const issue = conditionIssue(cond, typeName);
    const describedBy = issue ? ` aria-describedby="${cond.id}-issue"` : "";
    const type = paramTypeForPredicate(typeName, cond.predicate);
    if (type === "bool") {
      return `
        <div class="filter-value">
          ${toggle}
          <select class="filter-literal-bool" aria-label="Value"${describedBy}>${optionsHtml(
            [
              { value: "", label: "Pick…" },
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ],
            String(cond.literal || "").toLowerCase()
          )}</select>
        </div>
      `;
    }

    const placeholder = type === "int" || type === "float" ? "number" : "value";
    return `
      <div class="filter-value">
        ${toggle}
        <input type="text" class="filter-literal" value="${escapeAttr(cond.literal || "")}" placeholder="${placeholder}" spellcheck="false" aria-label="Value" aria-invalid="${!!issue}"${describedBy}${type === "string" ? "" : ' inputmode="decimal"'} />
      </div>
    `;
  }

  function renderFilterGroupPanel(group, typeName, node, { edgePath = "", title = "", emptyText = "" } = {}) {
    const g = ensureFilterGroup(group);
    const preds = scalarOptionsForType(typeName);
    const rows = g.conditions
      .map((cond) => {
        const issue = conditionIssue(cond, typeName);
        // A var filter with no variable to pick already says so in its value slot.
        const showIssue = issue && !(isVarFilter(cond.func) && !usableVars(node, typeName).length);
        return `
          <div class="filter-row${issue ? " is-incomplete" : ""}" data-filter-id="${cond.id}">
            ${
              isVarFilter(cond.func)
                ? `<span class="filter-self" title="The ${escapeAttr(typeName)} nodes themselves">${escapeAttr(typeName)}</span>`
                : `<select class="filter-predicate" aria-label="Predicate">${optionsHtml(
                    preds.length ? preds : [{ value: "", label: "—" }],
                    cond.predicate || ""
                  )}</select>`
            }
            <select class="filter-func" aria-label="Function">${optionsHtml(FILTER_FUNCS, cond.func || "eq")}</select>
            ${renderFilterValueControls(cond, node, typeName)}
            <button type="button" class="btn-icon is-danger filter-remove" title="Remove condition" aria-label="Remove condition">${ICON_CLOSE}</button>
            ${showIssue ? `<p class="filter-issue" id="${cond.id}-issue">${escapeAttr(issue)}</p>` : ""}
          </div>
        `;
      })
      .join("");

    const opToggle =
      g.conditions.length > 1
        ? `
          <div class="segmented" role="group" aria-label="Combine conditions with">
            <button type="button" class="filter-op-btn${g.op !== "OR" ? " active" : ""}" data-op="AND" aria-pressed="${g.op !== "OR"}" title="Match all conditions">AND</button>
            <button type="button" class="filter-op-btn${g.op === "OR" ? " active" : ""}" data-op="OR" aria-pressed="${g.op === "OR"}" title="Match any condition">OR</button>
          </div>
        `
        : "";

    return `
      <div class="filter-panel${edgePath ? " is-edge" : ""}" data-edge-path="${escapeAttr(edgePath)}">
        <div class="section-head">
          ${title ? `<span class="section-title">${escapeAttr(title)}</span>` : ""}
          ${opToggle}
          <button type="button" class="btn btn-quiet btn-sm push add-filter">${ICON_PLUS}Add condition</button>
        </div>
        ${rows || (emptyText ? `<p class="section-empty">${escapeAttr(emptyText)}</p>` : "")}
      </div>
    `;
  }

  function fieldTypeLabel(field) {
    if (field.kind !== "object" || !field.ofType) return field.type;
    return String(field.type || "").startsWith("[") ? `[${field.ofType}]` : field.ofType;
  }

  function renderFieldTree(typeName, selection, path, depth, aliases, node) {
    const def = schema[typeName];
    if (!def) return "";

    return def.fields
      .map((field) => {
        const fieldPath = [...path, field.name];
        const key = pathKey(fieldPath);
        const checked = isSelected(selection, fieldPath);
        const isObject = field.kind === "object";
        const label = fieldDisplayName(field.name);

        let edgeFilterHtml = "";
        let nestedHtml = "";
        let edgeFilterBtn = "";
        if (isObject && checked && field.ofType && schema[field.ofType] && depth < 8) {
          const edgeGroup = node.edgeFilters?.[key];
          if (edgeGroup?.conditions?.length) {
            edgeFilterHtml = renderFilterGroupPanel(edgeGroup, field.ofType, node, {
              edgePath: key,
              title: `Filter ${label}`,
            });
          } else {
            edgeFilterBtn = `<button type="button" class="field-filter-btn add-edge-filter" data-edge-path="${escapeAttr(key)}" title="Only return the ${escapeAttr(label)} nodes that match a condition" aria-label="Filter ${escapeAttr(label)}">${ICON_FILTER}Filter</button>`;
          }
          nestedHtml = `
            <ul class="nested-fields">
              ${renderFieldTree(field.ofType, selection, fieldPath, depth + 1, aliases, node)}
            </ul>
          `;
        }

        const aliasHtml = checked
          ? `<input
              type="text"
              class="alias-input"
              data-alias-path="${escapeAttr(encodePath(fieldPath))}"
              value="${escapeAttr(aliases[key] || "")}"
              placeholder="alias"
              spellcheck="false"
              aria-label="Alias for ${escapeAttr(label)}"
              title="Alias: the key this predicate gets in the result"
            />`
          : "";

        const typeLabel = fieldTypeLabel(field);
        return `
          <li class="field-item" data-name="${escapeAttr(label.toLowerCase())}">
            <div class="field-row${isObject ? " is-object" : ""}${checked ? " is-checked" : ""}">
              <label class="field-check">
                <input
                  type="checkbox"
                  data-path="${escapeAttr(encodePath(fieldPath))}"
                  data-kind="${field.kind}"
                  data-oftype="${field.ofType || ""}"
                  ${checked ? "checked" : ""}
                />
                <span class="field-name" title="${escapeAttr(field.name)}">${escapeAttr(label)}</span>
              </label>
              ${aliasHtml}
              ${edgeFilterBtn}
              <span class="field-type" title="${escapeAttr(typeLabel)}">${escapeAttr(typeLabel)}</span>
            </div>
            ${edgeFilterHtml}
            ${nestedHtml}
          </li>
        `;
      })
      .join("");
  }

  /** Hide field rows that don't match the block's search, keeping ancestors of matches. */
  function applyFieldSearch(nodeEl, query) {
    const q = String(query || "").trim().toLowerCase();
    const list = nodeEl.querySelector(".field-list");
    if (!list) return;

    const filterList = (ul) => {
      let any = false;
      [...ul.children].forEach((li) => {
        if (!li.classList.contains("field-item")) return;
        const nested = li.querySelector(":scope > .nested-fields");
        const childMatch = nested ? filterList(nested) : false;
        const visible = !q || childMatch || (li.dataset.name || "").includes(q);
        li.hidden = !visible;
        any = any || visible;
      });
      return any;
    };

    const any = filterList(list);
    let empty = nodeEl.querySelector(".field-empty");
    if (!any) {
      if (!empty) {
        empty = document.createElement("p");
        empty.className = "field-empty";
        list.after(empty);
      }
      empty.textContent = `No fields match "${String(query).trim()}"`;
    } else if (empty) {
      empty.remove();
    }
  }

  function countSelected(selection) {
    if (!selection || typeof selection !== "object") return 0;
    return Object.values(selection).reduce(
      (sum, v) => sum + 1 + (v && typeof v === "object" ? countSelected(v) : 0),
      0
    );
  }

  function optionsHtml(items, selected) {
    const list = items.slice();
    if (selected != null && selected !== "" && !list.some((item) => item.value === selected)) {
      list.push({ value: selected, label: selected });
    }
    return list
      .map(
        (item) =>
          `<option value="${escapeAttr(item.value)}" ${item.value === selected ? "selected" : ""}>${escapeAttr(item.label)}</option>`
      )
      .join("");
  }

  function renderParamsSection(node) {
    const typeOpts = PARAM_TYPES.map((t) => ({ value: t, label: t }));
    const rows = (node.params || [])
      .map(
        (param) => `
          <div class="param-grid param-card" data-param-id="${param.id}">
            <input type="text" class="param-name" value="${escapeAttr(param.name)}" placeholder="name" spellcheck="false" aria-label="Variable name" />
            <select class="param-type" aria-label="Variable type">${optionsHtml(typeOpts, param.type)}</select>
            <input type="text" class="param-value" value="${escapeAttr(param.value)}" placeholder="value" spellcheck="false" aria-label="Variable value" title="Value sent in the Variables JSON" />
            <label class="param-default" title="Also write this value as the default in the query signature">
              <input type="checkbox" class="param-mode" ${param.mode === "default" ? "checked" : ""} aria-label="Use as default" />
            </label>
            <button type="button" class="btn-icon is-danger param-remove" title="Remove variable" aria-label="Remove variable">${ICON_CLOSE}</button>
          </div>
        `
      )
      .join("");

    const head = rows
      ? `
        <div class="param-grid param-grid-head" aria-hidden="true">
          <span>Name</span><span>Type</span><span>Value</span><span>Default</span><span></span>
        </div>
      `
      : "";

    return `
      <div class="node-section params-section">
        <div class="section-head">
          <button type="button" class="btn btn-quiet btn-sm push add-param">${ICON_PLUS}Add variable</button>
        </div>
        ${head}${rows || '<p class="section-empty">Variables become $name in the query and can be used as filter values.</p>'}
      </div>
    `;
  }

  function renderRootFiltersSection(node) {
    return `
      <div class="node-section filters-section">
        ${renderFilterGroupPanel(node.rootFilter, node.type, node, {
          edgePath: "",
          emptyText: `No conditions. Every ${node.type} is returned.`,
        })}
      </div>
    `;
  }

  function renderQuerySection(node) {
    const toggle = (key) => `
      <button
        type="button"
        class="chip directive-toggle${node.directives?.[key] ? " active" : ""}"
        data-directive="${key}"
        aria-pressed="${!!node.directives?.[key]}"
        title="Toggle @${key} on this block"
      >@${key}</button>
    `;
    const resultPlaceholder = innerBlockName(sanitizeName(node.name, `get${node.type}`));
    const isVar = !!node.varName;
    const users = variableUsers(node);
    const startOptions = [
      { value: "", label: `All ${node.type}` },
      ...usableVars(node, node.type).map((name) => ({ value: name, label: `Nodes in ${name}` })),
    ];
    const usage = users.length
      ? `Used by ${users.map((u) => escapeAttr(u.varName || u.name)).join(", ")}.`
      : "Not used yet. Pick it in another block's Start from, or filter with uid(var). Until then it's left out of the DQL.";
    return `
      <div class="node-section">
        <div class="kv">
          <span class="kv-label">Variable</span>
          <div class="var-row">
            <label class="check-inline" title="Turn this block into name as var(...): it is not returned, other blocks can use its nodes">
              <input type="checkbox" class="var-toggle" ${isVar ? "checked" : ""} />
              Use as variable
            </label>
            ${
              isVar
                ? `<input type="text" class="var-name-input" value="${escapeAttr(node.varName)}" spellcheck="false" aria-label="Variable name" />`
                : ""
            }
          </div>
          ${isVar ? `<span></span><p class="kv-note${users.length ? "" : " is-warn"}">${usage}</p>` : ""}
          <label class="kv-label" for="${node.id}-start">Start from</label>
          <select id="${node.id}-start" class="root-var-select" title="Which ${escapeAttr(node.type)} nodes this block starts from"${startOptions.length > 1 ? "" : ` aria-describedby="${node.id}-start-help"`}>${optionsHtml(
            startOptions,
            node.rootVar || ""
          )}</select>
          ${
            startOptions.length > 1
              ? ""
              : `<p class="kv-help" id="${node.id}-start-help">To start from fewer nodes, turn on “Use as variable” in another ${escapeAttr(node.type)} block.</p>`
          }
          <label class="kv-label" for="${node.id}-name" ${isVar ? "hidden" : ""}>Name</label>
          <input
            ${isVar ? "hidden" : ""}
            type="text"
            id="${node.id}-name"
            class="query-name-input"
            value="${escapeAttr(node.name)}"
            spellcheck="false"
            title="Operation name: query <name>"
          />
          <label class="kv-label" for="${node.id}-result" ${isVar ? "hidden" : ""}>Result key</label>
          <input
            ${isVar ? "hidden" : ""}
            type="text"
            id="${node.id}-result"
            class="result-name-input"
            value="${escapeAttr(node.resultName || "")}"
            placeholder="${escapeAttr(resultPlaceholder)}"
            spellcheck="false"
            title="Key of this block in the response. Leave empty to use the default."
          />
          <span class="kv-label">Directives</span>
          <div class="chips">
            ${toggle("cascade")}
            ${toggle("normalize")}
          </div>
        </div>
      </div>
    `;
  }

  /* A re-render replaces every block's DOM. Remember which control had focus as
     a selector inside its block, so keyboard users stay where they were. */

  const FOCUS_ATTRS = ["path", "aliasPath", "tab", "directive", "op", "edgePath"];

  function controlSelector(el) {
    const cls = [...el.classList].find((c) => !c.startsWith("is-") && c !== "btn" && c !== "btn-icon");
    let sel = el.tagName.toLowerCase() + (cls ? `.${cls}` : "");
    FOCUS_ATTRS.forEach((attr) => {
      const value = el.dataset[attr];
      if (value == null) return;
      const name = attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      sel += `[data-${name}="${CSS.escape(value)}"]`;
    });
    return sel;
  }

  function captureFocus() {
    const el = document.activeElement;
    const nodeEl = el?.closest?.(".entity-node");
    if (!nodeEl || !canvasEl.contains(nodeEl)) return null;

    const scopes = [];
    const row = el.closest("[data-filter-id], [data-param-id]");
    const panel = el.closest(".filter-panel");
    if (panel) scopes.push(`.filter-panel[data-edge-path="${CSS.escape(panel.dataset.edgePath || "")}"]`);
    if (row?.dataset.filterId) scopes.push(`[data-filter-id="${row.dataset.filterId}"]`);
    if (row?.dataset.paramId) scopes.push(`[data-param-id="${row.dataset.paramId}"]`);

    // When the row itself goes away (a removed condition or variable), land on its "Add" button.
    let fallback = null;
    if (row?.dataset.filterId && panel) fallback = `${scopes[0]} .add-filter`;
    else if (row?.dataset.paramId) fallback = ".add-param";

    const control = el === nodeEl ? "" : controlSelector(el);
    return {
      id: nodeEl.dataset.id,
      selector: [...(row ? scopes : scopes.slice(0, 1)), control].filter(Boolean).join(" ") || null,
      fallback,
      selection:
        typeof el.selectionStart === "number" ? [el.selectionStart, el.selectionEnd] : null,
    };
  }

  function restoreFocus(saved) {
    if (!saved) return;
    const nodeEl = canvasEl.querySelector(`.entity-node[data-id="${saved.id}"]`);
    if (!nodeEl) {
      // The block is gone: keep focus on the canvas instead of dropping it to <body>.
      (nodes.length ? canvasEl : addEntityBtn).focus({ preventScroll: true });
      return;
    }
    const find = (sel) => {
      if (!sel) return null;
      try {
        return [...nodeEl.querySelectorAll(sel)].find((el) => !el.closest("[hidden]")) || null;
      } catch {
        return null;
      }
    };
    const target =
      find(saved.selector) ||
      find(saved.fallback) ||
      nodeEl.querySelector('.node-tab[aria-selected="true"]') ||
      nodeEl.querySelector(".entity-node-header");
    target?.focus({ preventScroll: true });
    if (saved.selection && target === find(saved.selector) && typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(...saved.selection);
      } catch {
        /* not a text field */
      }
    }
  }

  function renderNodes() {
    const savedFocus = captureFocus();
    // Full re-render replaces the DOM — keep field-list scroll so toggling
    // a property near the bottom doesn't jump back to the top.
    const fieldScroll = new Map();
    canvasEl.querySelectorAll(".entity-node").forEach((el) => {
      const id = el.dataset.id;
      const body = el.querySelector(".entity-node-body");
      if (id && body) {
        fieldScroll.set(id, { top: body.scrollTop, left: body.scrollLeft });
      }
    });

    canvasEl.querySelectorAll(".entity-node").forEach((el) => {
      surfaceObserver.unobserve(el);
      el.remove();
    });

    nodes.forEach((node) => {
      const def = schema[node.type];
      const el = document.createElement("article");
      el.className = `entity-node${selectedNodeId === node.id ? " selected" : ""}`;
      el.dataset.id = node.id;
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      el.style.zIndex = selectedNodeId === node.id ? "5" : "2";
      const size = estimateNodeSize(node);
      el.style.width = `${size.w}px`;
      // Blocks fit their content up to the stored height; a manual resize fixes it.
      if (node.fixedHeight) el.style.height = `${size.h}px`;
      else el.style.maxHeight = `${size.h}px`;
      if (!node.width) node.width = size.w;
      if (!node.height) node.height = size.h;

      const fieldQuery = fieldQueries.get(node.id) || "";
      const activeTab = nodeTabs.get(node.id) || "fields";
      const fieldsHtml = `
        <div class="node-section fields-section">
          <input type="search" class="field-search" value="${escapeAttr(fieldQuery)}" placeholder="Search fields" spellcheck="false" aria-label="Search fields" />
          <ul class="field-list">${renderFieldTree(node.type, node.selection, [], 0, node.aliases || {}, node)}</ul>
        </div>
      `;

      el.innerHTML = `
        <header
          class="entity-node-header"
          data-drag-handle
          tabindex="0"
          role="group"
          aria-label="${escapeAttr(node.type)} block ${escapeAttr(node.varName || node.name)}"
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Delete ${MOD_KEY === "Ctrl" ? "Control" : "Meta"}+D"
          title="Drag to move. When focused: arrow keys move, Delete removes, ${MOD_KEY}+D duplicates."
        >
          <span class="dot" style="background:${dotColor(def.color)}"></span>
          <span class="entity-type-label">${escapeAttr(node.type)}</span>
          ${node.varName ? `<span class="node-tag is-var" title="Defines the variable ${escapeAttr(node.varName)}; not returned">as ${escapeAttr(node.varName)}</span>` : ""}
          <span class="entity-node-name" ${node.varName ? "hidden" : ""}>${escapeAttr(node.name)}</span>
          ${node.rootVar ? `<span class="node-tag" title="Starts from the nodes in ${escapeAttr(node.rootVar)}">from ${escapeAttr(node.rootVar)}</span>` : ""}
          <span class="entity-node-actions">
            <button type="button" class="btn-icon entity-node-duplicate" title="Duplicate block (${MOD_KEY}+D)" aria-label="Duplicate ${escapeAttr(node.type)} block">${ICON_DUPLICATE}</button>
            <button type="button" class="btn-icon is-danger entity-node-remove" title="Remove block (Delete)" aria-label="Remove ${escapeAttr(node.type)} block">${ICON_CLOSE}</button>
          </span>
        </header>
        <div class="node-tabs" role="tablist" aria-label="${escapeAttr(node.type)} block">
          ${renderNodeTabs(node, activeTab)}
        </div>
        <div class="entity-node-body">
          ${nodePanel(node, "fields", activeTab, fieldsHtml)}
          ${nodePanel(node, "filter", activeTab, renderRootFiltersSection(node))}
          ${nodePanel(node, "variables", activeTab, renderParamsSection(node))}
          ${nodePanel(node, "settings", activeTab, renderQuerySection(node))}
        </div>
        <div class="entity-resize" data-resize-handle title="Drag to resize"></div>
      `;

      const header = el.querySelector(".entity-node-header");
      const headerName = el.querySelector(".entity-node-name");
      const nameInput = el.querySelector(".query-name-input");
      const resultInput = el.querySelector(".result-name-input");

      const tabs = [...el.querySelectorAll(".node-tab")];
      const showTab = (tabId, { focus = false } = {}) => {
        nodeTabs.set(node.id, tabId);
        tabs.forEach((tab) => {
          const active = tab.dataset.tab === tabId;
          tab.setAttribute("aria-selected", String(active));
          tab.tabIndex = active ? 0 : -1;
          if (active && focus) tab.focus();
        });
        el.querySelectorAll(".node-panel").forEach((panel) => {
          panel.hidden = panel.dataset.panel !== tabId;
        });
        el.querySelector(".entity-node-body").scrollTop = 0;
      };
      tabs.forEach((tab, i) => {
        stopDragPropagation(tab);
        tab.addEventListener("click", () => showTab(tab.dataset.tab));
        tab.addEventListener("keydown", (e) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (!step) return;
          e.preventDefault();
          e.stopPropagation();
          showTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, { focus: true });
        });
      });

      const fieldSearch = el.querySelector(".field-search");
      stopDragPropagation(fieldSearch);
      fieldSearch.addEventListener("input", () => {
        fieldQueries.set(node.id, fieldSearch.value);
        applyFieldSearch(el, fieldSearch.value);
      });
      fieldSearch.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && fieldSearch.value) {
          e.stopPropagation();
          fieldSearch.value = "";
          fieldQueries.delete(node.id);
          applyFieldSearch(el, "");
        }
      });

      header.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".entity-node-actions")) return;
        e.preventDefault();
        header.focus({ preventScroll: true });
        setSelected(node.id);
        const rect = el.getBoundingClientRect();
        moveState = {
          id: node.id,
          offsetX: e.clientX - rect.left,
          offsetY: e.clientY - rect.top,
        };
        el.classList.add("dragging");
        document.body.classList.add("is-dragging-node");
      });

      const resizeHandle = el.querySelector("[data-resize-handle]");
      if (resizeHandle) {
        resizeHandle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          setSelected(node.id);
          resizeState = {
            id: node.id,
            startX: e.clientX,
            startY: e.clientY,
            startW: el.offsetWidth,
            startH: el.offsetHeight,
          };
          el.classList.add("resizing");
          document.body.classList.add("is-resizing-node");
          resizeHandle.setPointerCapture?.(e.pointerId);
        });
      }

      header.addEventListener("keydown", (e) => {
        if (e.target !== header) return;
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          const step = e.shiftKey ? 64 : 16;
          node.x = Math.max(0, node.x + arrows[e.key][0] * step);
          node.y = Math.max(0, node.y + arrows[e.key][1] * step);
          el.style.left = `${node.x}px`;
          el.style.top = `${node.y}px`;
          setSelected(node.id);
          updateCanvasSurface();
          scrollNodeIntoView(node.id);
          scheduleSaveWorkspace();
          scheduleHistoryCommit();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          removeNode(node.id);
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "d") {
          e.preventDefault();
          duplicateNode(node.id);
        }
      });

      el.querySelector(".entity-node-duplicate").addEventListener("click", (e) => {
        e.stopPropagation();
        duplicateNode(node.id);
      });

      // Pointing at a block brings its variable links forward.
      el.addEventListener("pointerenter", () => highlightLinks(node.id));
      el.addEventListener("pointerleave", () => highlightLinks(null));
      el.addEventListener("focusin", () => highlightLinks(node.id));
      el.addEventListener("focusout", (e) => {
        if (!el.contains(e.relatedTarget)) highlightLinks(null);
      });

      stopDragPropagation(nameInput);
      nameInput.addEventListener("input", () => {
        node.name = nameInput.value;
        headerName.textContent = node.name;
        resultInput.placeholder = innerBlockName(sanitizeName(node.name, `get${node.type}`));
        refreshQuery();
      });
      nameInput.addEventListener("change", () => {
        node.name = sanitizeName(nameInput.value, defaultName(node.type));
        nameInput.value = node.name;
        headerName.textContent = node.name;
        refreshQuery();
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
        e.stopPropagation();
      });

      stopDragPropagation(resultInput);
      resultInput.addEventListener("input", () => {
        node.resultName = resultInput.value;
        refreshQuery();
      });
      resultInput.addEventListener("change", () => {
        node.resultName = resultInput.value.trim()
          ? sanitizeName(resultInput.value, "")
          : "";
        resultInput.value = node.resultName;
        refreshQuery();
      });
      resultInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          resultInput.blur();
        }
        e.stopPropagation();
      });

      el.querySelectorAll(".alias-input").forEach((input) => {
        stopDragPropagation(input);
        const syncAliasSize = () => {
          const len = Math.max(5, Math.min(28, (input.value || "alias").length + 1));
          input.size = len;
        };
        syncAliasSize();
        input.addEventListener("input", () => {
          const key = pathKey(decodePath(input.dataset.aliasPath));
          const value = input.value.trim();
          if (value) node.aliases[key] = value;
          else delete node.aliases[key];
          syncAliasSize();
          refreshQuery();
        });
        input.addEventListener("change", () => {
          const key = pathKey(decodePath(input.dataset.aliasPath));
          if (node.aliases[key]) {
            // Aliases may be dotted (Author.Name), so keep dots.
            node.aliases[key] = node.aliases[key].replace(/[^A-Za-z0-9_.]/g, "_");
            input.value = node.aliases[key];
            syncAliasSize();
            refreshQuery();
          }
        });
        input.addEventListener("keydown", (e) => e.stopPropagation());
      });

      const varToggle = el.querySelector(".var-toggle");
      stopDragPropagation(varToggle);
      varToggle.addEventListener("change", () => {
        let message = "";
        if (varToggle.checked) {
          node.varName = uniqueVarName(`${node.type.charAt(0).toLowerCase()}${node.type.slice(1)}Ids`, node.id);
        } else {
          const users = variableUsers(node);
          if (users.length) {
            checkpoint();
            message = `${node.varName} is no longer a variable; ${usersPhrase(users.length)}`;
          }
          dropVarRefs(node.varName);
          node.varName = "";
        }
        renderNodes();
        refreshQuery();
        if (message) showUndoToast(message);
      });

      const varNameInput = el.querySelector(".var-name-input");
      if (varNameInput) {
        stopDragPropagation(varNameInput);
        varNameInput.addEventListener("change", () => {
          const next = uniqueVarName(varNameInput.value || node.varName, node.id);
          renameVarRefs(node.varName, next);
          node.varName = next;
          renderNodes();
          refreshQuery();
        });
        varNameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            varNameInput.blur();
          }
          e.stopPropagation();
        });
      }

      const rootVarSelect = el.querySelector(".root-var-select");
      stopDragPropagation(rootVarSelect);
      rootVarSelect.addEventListener("change", () => {
        node.rootVar = rootVarSelect.value;
        renderNodes();
        refreshQuery();
      });

      el.querySelector(".entity-node-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeNode(node.id);
      });

      el.querySelectorAll(".directive-toggle").forEach((btn) => {
        stopDragPropagation(btn);
        btn.addEventListener("click", () => {
          const key = btn.dataset.directive;
          node.directives[key] = !node.directives[key];
          btn.classList.toggle("active", node.directives[key]);
          btn.setAttribute("aria-pressed", String(node.directives[key]));
          refreshQuery();
        });
      });

      el.querySelector(".add-param").addEventListener("click", (e) => {
        e.stopPropagation();
        let name = `param${node.params.length + 1}`;
        let i = 2;
        while (node.params.some((p) => p.name === name)) {
          name = `param${i}`;
          i += 1;
        }
        node.params.push({
          id: paramUid(),
          name,
          type: "string",
          value: "",
          mode: "var",
        });
        renderNodes();
        refreshQuery();
      });

      el.querySelectorAll(".param-card").forEach((card) => {
        const param = node.params.find((p) => p.id === card.dataset.paramId);
        if (!param) return;

        const nameEl = card.querySelector(".param-name");
        const typeEl = card.querySelector(".param-type");
        const valueEl = card.querySelector(".param-value");
        const modeEl = card.querySelector(".param-mode");
        const removeBtn = card.querySelector(".param-remove");

        [nameEl, typeEl, valueEl, modeEl, removeBtn].forEach(stopDragPropagation);

        modeEl.addEventListener("change", () => {
          param.mode = modeEl.checked ? "default" : "var";
          refreshQuery();
        });
        nameEl.addEventListener("input", () => {
          const prev = param.name;
          param.name = nameEl.value.replace(/^\$/, "");
          // Keep filter references in sync while typing.
          const renameIn = (group) => {
            (group?.conditions || []).forEach((c) => {
              if (c.valueMode === "param" && c.paramName === prev) c.paramName = param.name;
            });
          };
          renameIn(node.rootFilter);
          Object.values(node.edgeFilters || {}).forEach(renameIn);
          refreshQuery();
        });
        nameEl.addEventListener("change", () => {
          const prev = param.name;
          param.name = sanitizeName(param.name, "param");
          nameEl.value = param.name;
          const renameIn = (group) => {
            (group?.conditions || []).forEach((c) => {
              if (c.valueMode === "param" && c.paramName === prev) c.paramName = param.name;
            });
          };
          renameIn(node.rootFilter);
          Object.values(node.edgeFilters || {}).forEach(renameIn);
          renderNodes();
          refreshQuery();
        });
        typeEl.addEventListener("change", () => {
          param.type = typeEl.value;
          if (!param.value) param.value = defaultParamValue(param.type);
          refreshQuery();
        });
        valueEl.addEventListener("input", () => {
          param.value = valueEl.value;
          refreshQuery();
        });
        removeBtn.addEventListener("click", () => {
          const removed = param.name;
          node.params = node.params.filter((p) => p.id !== param.id);
          const clearRef = (group) => {
            (group?.conditions || []).forEach((c) => {
              if (c.valueMode === "param" && c.paramName === removed) {
                c.paramName = "";
              }
            });
          };
          clearRef(node.rootFilter);
          Object.values(node.edgeFilters || {}).forEach(clearRef);
          renderNodes();
          refreshQuery();
        });
      });

      const getFilterGroup = (edgePath) => {
        if (!edgePath) {
          if (!node.rootFilter) node.rootFilter = emptyFilterGroup();
          return node.rootFilter;
        }
        if (!node.edgeFilters) node.edgeFilters = {};
        if (!node.edgeFilters[edgePath]) node.edgeFilters[edgePath] = emptyFilterGroup();
        return node.edgeFilters[edgePath];
      };

      const addCondition = (edgePath) => {
        const group = getFilterGroup(edgePath);
        const typeName = typeAtEdgePath(node.type, edgePath);
        const preds = scalarPredicates(typeName);
        const used = new Set(group.conditions.map((c) => c.predicate));
        const next = preds.find((p) => !used.has(p.name)) || preds[0];
        const predName = next?.name || "";
        group.conditions.push(newFilterCondition(predName));
        renderNodes();
        refreshQuery();
      };

      el.querySelectorAll(".add-edge-filter").forEach((btn) => {
        stopDragPropagation(btn);
        btn.addEventListener("click", () => addCondition(btn.dataset.edgePath || ""));
      });

      el.querySelectorAll(".filter-panel").forEach((panel) => {
        const edgePath = panel.dataset.edgePath || "";
        const group = getFilterGroup(edgePath);
        const typeName = typeAtEdgePath(node.type, edgePath);

        panel.querySelectorAll(".filter-op-btn").forEach((btn) => {
          stopDragPropagation(btn);
          btn.addEventListener("click", () => {
            group.op = btn.dataset.op === "OR" ? "OR" : "AND";
            renderNodes();
            refreshQuery();
          });
        });

        panel.querySelector(".add-filter")?.addEventListener("click", (e) => {
          e.stopPropagation();
          addCondition(edgePath);
        });

        panel.querySelectorAll(".filter-row").forEach((row) => {
          const cond = group.conditions.find((c) => c.id === row.dataset.filterId);
          if (!cond) return;

          const funcEl = row.querySelector(".filter-func");
          const predEl = row.querySelector(".filter-predicate");
          const modeEl = row.querySelector(".filter-value-mode");
          const literalEl = row.querySelector(".filter-literal");
          const boolEl = row.querySelector(".filter-literal-bool");
          const paramEl = row.querySelector(".filter-param");
          const varRefEl = row.querySelector(".filter-var-ref");
          const removeBtn = row.querySelector(".filter-remove");

          [funcEl, predEl, modeEl, literalEl, boolEl, paramEl, varRefEl, removeBtn]
            .filter(Boolean)
            .forEach(stopDragPropagation);

          funcEl?.addEventListener("change", () => {
            cond.func = funcEl.value;
            if (isUnaryFilter(cond.func) || isVarFilter(cond.func)) {
              cond.valueMode = "literal";
              cond.literal = "";
              cond.paramName = "";
            }
            if (isVarFilter(cond.func) && !cond.varRef) {
              cond.varRef = usableVars(node, typeName)[0] || "";
            }
            renderNodes();
            refreshQuery();
          });
          predEl?.addEventListener("change", () => {
            const prevType = paramTypeForPredicate(typeName, cond.predicate);
            cond.predicate = predEl.value;
            const type = paramTypeForPredicate(typeName, cond.predicate);
            // A value typed for one predicate type rarely fits another; keep it otherwise.
            if (type !== prevType) {
              if (cond.valueMode === "literal") cond.literal = "";
              renderNodes();
            } else {
              updateConditionState(el, node, row, cond, typeName);
            }
            refreshQuery();
          });
          modeEl?.addEventListener("click", () => {
            cond.valueMode = cond.valueMode === "param" ? "literal" : "param";
            if (cond.valueMode === "param") {
              if (!cond.paramName && node.params[0]) cond.paramName = node.params[0].name;
              if (!cond.paramName) {
                // Auto-create a param from the predicate leaf.
                const seed = sanitizeName(
                  (cond.predicate || "param").replace(/\./g, "_"),
                  "param"
                );
                let name = seed;
                let i = 2;
                while (node.params.some((p) => p.name === name)) {
                  name = `${seed}${i}`;
                  i += 1;
                }
                const type = paramTypeForPredicate(typeName, cond.predicate);
                node.params.push({
                  id: paramUid(),
                  name,
                  type,
                  value: defaultParamValue(type),
                  mode: "var",
                });
                cond.paramName = name;
              }
            }
            renderNodes();
            refreshQuery();
          });
          literalEl?.addEventListener("input", () => {
            cond.literal = literalEl.value;
            updateConditionState(el, node, row, cond, typeName);
            refreshQuery();
          });
          boolEl?.addEventListener("change", () => {
            cond.literal = boolEl.value;
            updateConditionState(el, node, row, cond, typeName);
            refreshQuery();
          });
          paramEl?.addEventListener("change", () => {
            cond.paramName = paramEl.value;
            updateConditionState(el, node, row, cond, typeName);
            refreshQuery();
          });
          varRefEl?.addEventListener("change", () => {
            cond.varRef = varRefEl.value;
            renderNodes();
            refreshQuery();
          });
          removeBtn?.addEventListener("click", () => {
            group.conditions = group.conditions.filter((c) => c.id !== cond.id);
            if (edgePath && !group.conditions.length) {
              delete node.edgeFilters[edgePath];
            }
            renderNodes();
            refreshQuery();
          });
        });
      });

      el.querySelectorAll('.field-check input[type="checkbox"]').forEach((input) => {
        input.addEventListener("change", () => {
          const path = decodePath(input.dataset.path);
          const kind = input.dataset.kind;
          const current = getNode(node.id);
          if (!current) return;

          checkpoint();
          let lost = "";
          if (input.checked) {
            if (kind === "object") {
              current.selection = setAtPath(current.selection, path, {});
            } else {
              current.selection = setAtPath(current.selection, path, null);
            }
          } else {
            const pathStr = pathKey(path);
            const nested = countSelected(getAtPath(current.selection, path));
            const nestedFilters = Object.entries(current.edgeFilters || {})
              .filter(([key]) => key === pathStr || key.startsWith(`${pathStr}.`))
              .reduce((sum, [, g]) => sum + (g?.conditions?.length || 0), 0);
            const parts = [];
            if (nested) parts.push(`${nested} nested field${nested === 1 ? "" : "s"}`);
            if (nestedFilters) parts.push(`${nestedFilters} filter${nestedFilters === 1 ? "" : "s"}`);
            if (parts.length) lost = `Removed ${fieldDisplayName(path[path.length - 1])} with ${parts.join(" and ")}`;
            current.selection = setAtPath(current.selection, path, undefined);
            Object.keys(current.aliases || {}).forEach((key) => {
              if (key === pathStr || key.startsWith(`${pathStr}.`)) {
                delete current.aliases[key];
              }
            });
            // Drop edge filters on this edge and anything nested under it.
            Object.keys(current.edgeFilters || {}).forEach((key) => {
              if (key === pathStr || key.startsWith(`${pathStr}.`)) {
                delete current.edgeFilters[key];
              }
            });
          }
          renderNodes();
          refreshQuery();
          if (lost) showUndoToast(lost);
        });
      });

      el.addEventListener("mousedown", (e) => {
        if (e.target.closest("input, label, button, select")) return;
        setSelected(node.id);
      });

      canvasEl.appendChild(el);
      surfaceObserver.observe(el);
      if (fieldQuery) applyFieldSearch(el, fieldQuery);

      const savedScroll = fieldScroll.get(node.id);
      if (savedScroll) {
        const body = el.querySelector(".entity-node-body");
        if (body) {
          body.scrollTop = savedScroll.top;
          body.scrollLeft = savedScroll.left;
        }
      }
    });

    updateEmptyState();
    updateCanvasSurface();
    restoreFocus(savedFocus);
  }

  function removeNode(id) {
    const node = getNode(id);
    if (!node) return;
    checkpoint();
    const users = variableUsers(node);
    if (node.varName) dropVarRefs(node.varName);
    nodes = nodes.filter((n) => n.id !== id);
    fieldQueries.delete(id);
    nodeTabs.delete(id);
    if (selectedNodeId === id) selectedNodeId = null;
    renderNodes();
    refreshQuery();
    const label = `${node.type} block${node.varName ? ` (${node.varName})` : ""}`;
    showUndoToast(users.length ? `Removed ${label}; ${usersPhrase(users.length)}` : `Removed ${label}`);
  }

  /** Copy a block next to the original with fresh ids and names. */
  function duplicateNode(id) {
    const source = getNode(id);
    if (!source) return;
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = uid();
    copy.name = defaultName(source.type);
    copy.resultName = "";
    if (source.varName) copy.varName = uniqueVarName(source.varName, copy.id);
    copy.params = (copy.params || []).map((p) => ({ ...p, id: paramUid() }));
    const freshIds = (g) => {
      (g?.conditions || []).forEach((c) => {
        c.id = filterUid();
      });
    };
    freshIds(copy.rootFilter);
    Object.values(copy.edgeFilters || {}).forEach(freshIds);

    const size = estimateNodeSize(source);
    const pos = findFreePosition(size.w, size.h, { x: source.x + size.w + NODE_GAP, y: source.y });
    copy.x = pos.x;
    copy.y = pos.y;
    nodes.push(copy);
    nodeTabs.set(copy.id, nodeTabs.get(id) || "fields");
    selectedNodeId = copy.id;
    renderNodes();
    refreshQuery();
    scrollNodeIntoView(copy.id);
    canvasEl.querySelector(`.entity-node[data-id="${copy.id}"] .entity-node-header`)?.focus({ preventScroll: true });
    announce(`Duplicated ${source.type} block`);
  }

  function placeEntity(typeName, x, y) {
    if (!schema[typeName]) return;

    const pos =
      x != null && y != null
        ? findFreePosition(DEFAULT_NODE_W, DEFAULT_NODE_H, { x, y })
        : findFreePosition(DEFAULT_NODE_W, DEFAULT_NODE_H);

    nodes.push({
      id: uid(),
      type: typeName,
      name: defaultName(typeName),
      x: pos.x,
      y: pos.y,
      width: DEFAULT_NODE_W,
      height: DEFAULT_NODE_H,
      selection: defaultSelection(typeName),
      params: [],
      rootFilter: emptyFilterGroup(),
      edgeFilters: {},
      directives: { cascade: false, normalize: false },
      aliases: {},
      resultName: "",
      varName: "",
      rootVar: "",
    });
    selectedNodeId = nodes[nodes.length - 1].id;
    renderNodes();
    refreshQuery();
  }

  /* ---------- DQL generation ---------- */

  function indent(level) {
    return "  ".repeat(level);
  }

  function hasAnySelection(selection) {
    return selection && typeof selection === "object" && Object.keys(selection).length > 0;
  }

  function renderSelection(typeName, selection, depth, node, pathPrefix, aliases) {
    const def = schema[typeName];
    if (!def || !hasAnySelection(selection)) return "";

    const lines = [];
    def.fields.forEach((field) => {
      if (!(field.name in selection)) return;

      const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name;
      const alias = aliases[fieldPath] ? `${aliases[fieldPath]}: ` : "";

      if (field.kind === "scalar") {
        lines.push(`${indent(depth)}${alias}${field.name}`);
        return;
      }

      const nestedType = field.ofType;
      const filterStr = formatFilterDirective(
        node.edgeFilters?.[fieldPath],
        nestedType || typeName
      );

      const nestedSel = selection[field.name];

      // Depth cap only — allow the same type to reappear on a nested edge
      // (e.g. User → posts → author → User) so long as the selection is finite.
      if (!nestedType || !schema[nestedType] || depth >= 14) {
        lines.push(`${indent(depth)}${alias}${field.name}${filterStr} {`);
        lines.push(`${indent(depth)}}`);
        return;
      }

      const nestedBody = renderSelection(
        nestedType,
        nestedSel && typeof nestedSel === "object" ? nestedSel : {},
        depth + 1,
        node,
        fieldPath,
        aliases
      );
      lines.push(`${indent(depth)}${alias}${field.name}${filterStr} {`);
      if (nestedBody) lines.push(nestedBody);
      lines.push(`${indent(depth)}}`);
    });

    return lines.join("\n");
  }

  function uniqueBlockNames(roots) {
    const seen = new Map();
    return roots.map((node) => {
      const fallback = `get${node.type}`;
      let name = sanitizeName(node.name, fallback);
      if (seen.has(name)) {
        const count = seen.get(name) + 1;
        seen.set(name, count);
        name = `${name}_${count}`;
      } else {
        seen.set(name, 1);
      }
      return name;
    });
  }

  /** Format a param's value as a DQL literal ("Alice", 42, true). */
  function formatDqlLiteral(param) {
    if (param.type === "int") {
      const n = parseInt(param.value, 10);
      return String(Number.isFinite(n) ? n : 0);
    }
    if (param.type === "float") {
      const n = parseFloat(param.value);
      return String(Number.isFinite(n) ? n : 0);
    }
    if (param.type === "bool") {
      return String(String(param.value).toLowerCase() === "true");
    }
    return JSON.stringify(String(param.value ?? ""));
  }

  function formatParamValue(param) {
    if (param.type === "int") {
      const n = parseInt(param.value, 10);
      return Number.isFinite(n) ? n : 0;
    }
    if (param.type === "float") {
      const n = parseFloat(param.value);
      return Number.isFinite(n) ? n : 0;
    }
    if (param.type === "bool") {
      return String(param.value).toLowerCase() === "true";
    }
    return String(param.value ?? "");
  }

  /** Why a condition can't go into the query yet, or "" when it is complete. */
  function conditionIssue(cond, typeName) {
    if (!cond?.func) return "Pick a function";
    if (isVarFilter(cond.func)) {
      return cond.varRef && varDefiner(cond.varRef) ? "" : "Pick a variable block";
    }
    if (!cond.predicate) return "Pick a predicate";
    if (isUnaryFilter(cond.func)) return "";
    if (cond.valueMode === "param") {
      const name = sanitizeName(cond.paramName, "");
      const exists = nodes.some((n) => (n.params || []).some((p) => sanitizeName(p.name, "") === name));
      return name && exists ? "" : "Pick a variable";
    }
    const value = String(cond.literal ?? "").trim();
    if (!value) return "Needs a value";
    const type = paramTypeForPredicate(typeName, cond.predicate);
    if (type === "int" && !/^[+-]?\d+$/.test(value)) return "Needs a whole number";
    if (type === "float" && !Number.isFinite(Number(value))) return "Needs a number";
    if (type === "bool" && !/^(true|false)$/i.test(value)) return "Needs true or false";
    return "";
  }

  /** Call fn(cond, typeName, edgePath) for every filter condition of a block. */
  function forEachCondition(node, fn) {
    (node.rootFilter?.conditions || []).forEach((c) => fn(c, node.type, ""));
    Object.entries(node.edgeFilters || {}).forEach(([edgePath, g]) => {
      const typeName = typeAtEdgePath(node.type, edgePath);
      (g?.conditions || []).forEach((c) => fn(c, typeName, edgePath));
    });
  }

  /** Incomplete conditions on the block itself (Filter tab) and on its edges (Fields tab). */
  function countIncomplete(node) {
    const counts = { root: 0, edges: 0 };
    forEachCondition(node, (c, typeName, edgePath) => {
      if (conditionIssue(c, typeName)) counts[edgePath ? "edges" : "root"] += 1;
    });
    return counts;
  }

  function formatFilterCondition(cond, typeName) {
    if (conditionIssue(cond, typeName)) return null;
    if (isVarFilter(cond.func)) return `${cond.func}(${cond.varRef})`;
    if (isUnaryFilter(cond.func)) return `${cond.func}(${cond.predicate})`;

    if (cond.valueMode === "param") {
      return `${cond.func}(${cond.predicate}, $${sanitizeName(cond.paramName, "")})`;
    }

    const type = paramTypeForPredicate(typeName, cond.predicate);
    const valuePart = formatDqlLiteral({ type, value: cond.literal });
    return `${cond.func}(${cond.predicate}, ${valuePart})`;
  }

  function formatFilterDirective(group, typeName) {
    const g = ensureFilterGroup(group);
    const parts = g.conditions
      .map((c) => formatFilterCondition(c, typeName))
      .filter(Boolean);
    if (!parts.length) return "";
    return ` @filter(${parts.join(` ${g.op} `)})`;
  }

  /**
   * Result key inside the operation: "query getUser { User(...) }".
   * Strip a leading "get" when the remainder is a valid identifier,
   * otherwise reuse the operation name.
   */
  function innerBlockName(opName) {
    if (/^get./.test(opName)) {
      const rest = opName.slice(3);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest)) return rest;
    }
    return opName;
  }

  function blockParams(node) {
    const seen = new Set();
    const result = [];
    (node.params || []).forEach((param) => {
      const name = sanitizeName(param.name, "");
      if (!name || seen.has(name)) return;
      seen.add(name);
      result.push({ ...param, name });
    });
    return result;
  }

  /**
   * Group blocks into operations. Blocks linked through query variables share
   * one operation (variables only work inside one); every other block gets its
   * own. Variable blocks nothing reads are left out: Dgraph rejects unused
   * variables.
   */
  function planOperations() {
    let pool = nodes.filter((n) => n.varName || hasAnySelection(n.selection));
    const unused = [];
    for (;;) {
      const read = new Set(pool.flatMap(varRefs));
      const drop = pool.filter((n) => n.varName && !read.has(n.varName));
      if (!drop.length) break;
      unused.push(...drop.map((n) => n.varName));
      pool = pool.filter((n) => !drop.includes(n));
    }

    const parent = new Map(pool.map((n) => [n.id, n.id]));
    const find = (id) => (parent.get(id) === id ? id : find(parent.get(id)));
    pool.forEach((n) =>
      varRefs(n).forEach((name) => {
        const def = pool.find((d) => d.varName === name);
        if (def) parent.set(find(n.id), find(def.id));
      })
    );

    const groups = new Map();
    pool.forEach((n) => {
      const key = find(n.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    });

    // Variable definitions before the blocks that read them.
    const ordered = [...groups.values()].map((members) => {
      const out = [];
      const seen = new Set();
      const visit = (n) => {
        if (seen.has(n.id)) return;
        seen.add(n.id);
        varRefs(n).forEach((name) => {
          const def = members.find((m) => m.varName === name);
          if (def) visit(def);
        });
        out.push(n);
      };
      members.forEach(visit);
      return out;
    });

    return { operations: ordered, unused };
  }

  function refreshQuery() {
    try {
      const { operations: groups, unused } = planOperations();
      const incomplete = nodes.reduce((sum, n) => {
        const c = countIncomplete(n);
        return sum + c.root + c.edges;
      }, 0);
      const note =
        (unused.length ? `# Not used by any block yet, so left out: ${unused.join(", ")}\n` : "") +
        (incomplete
          ? `# ${incomplete} incomplete filter condition${incomplete === 1 ? " is" : "s are"} left out until finished\n`
          : "");
      if (!groups.length) {
        setOutputs(nodes.length ? note || "# Pick at least one predicate on a query block." : "", "");
        return;
      }

      const heads = groups.map((members) => members.find((n) => !n.varName) || members[0]);
      const names = uniqueBlockNames(heads);

      const opParams = groups.map((members) => {
        const seen = new Set();
        const out = [];
        members.forEach((n) =>
          blockParams(n).forEach((p) => {
            if (seen.has(p.name)) return;
            seen.add(p.name);
            out.push(p);
          })
        );
        return out;
      });

      const operations = groups.map((members, i) => {
        const keys = new Set();
        const blocks = members.map((node) => {
          const filter = formatFilterDirective(node.rootFilter, node.type);
          const directives =
            (node.directives?.cascade ? " @cascade" : "") +
            (node.directives?.normalize ? " @normalize" : "");
          const body =
            renderSelection(node.type, node.selection, 2, node, "", node.aliases || {}) ||
            `${indent(2)}uid`;
          const func = node.rootVar && varDefiner(node.rootVar) ? `uid(${node.rootVar})` : `type("${node.type}")`;

          let key;
          if (node.varName) {
            key = `${node.varName} as var`;
          } else {
            const base =
              sanitizeName(node.resultName, "") ||
              innerBlockName(node === heads[i] ? names[i] : sanitizeName(node.name, `get${node.type}`));
            key = base;
            for (let n = 2; keys.has(key); n += 1) key = `${base}${n}`;
            keys.add(key);
          }

          return (
            `${indent(1)}${key}(func: ${func})${filter}${directives} {\n` +
            `${body}\n${indent(1)}}`
          );
        });

        const params = opParams[i];
        const signature = params.length
          ? `(${params
              .map(
                (p) =>
                  `$${p.name}: ${p.type}${p.mode === "default" ? ` = ${formatDqlLiteral(p)}` : ""}`
              )
              .join(", ")})`
          : "";

        return `query ${names[i]}${signature} {\n${blocks.join("\n\n")}\n}`;
      });

      // One operation → flat vars object; several → grouped per operation,
      // since each operation is executed separately with its own variables.
      let vars = "";
      if (opParams.some((list) => list.length)) {
        const varsFor = (list) => {
          const obj = {};
          list.forEach((p) => {
            obj[`$${p.name}`] = formatParamValue(p);
          });
          return obj;
        };

        if (groups.length === 1) {
          vars = JSON.stringify(varsFor(opParams[0]), null, 2);
        } else {
          const grouped = {};
          groups.forEach((_, i) => {
            if (opParams[i].length) grouped[names[i]] = varsFor(opParams[i]);
          });
          vars = JSON.stringify(grouped, null, 2);
        }
      }

      setOutputs(note + operations.join("\n\n"), vars);
    } catch (err) {
      consoleError(err.message || String(err), "query-build");
      setOutputs(`# Query build failed:\n# ${err.message || err}`, "");
    } finally {
      scheduleSaveWorkspace();
      // Typing settles into one step; clicks and picks are a step each.
      if (isTextEntry(document.activeElement)) scheduleHistoryCommit();
      else commitHistory();
    }
  }

  /* ---------- Copy ---------- */

  async function copyText(text, button) {
    if (!text) return;
    const flash = (label, ms) => {
      clearTimeout(button._flashTimer);
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.textContent = label;
      button._flashTimer = setTimeout(() => {
        button.textContent = button.dataset.label;
      }, ms);
    };
    try {
      await navigator.clipboard.writeText(text);
      flash("Copied", 1200);
      announce("Copied to the clipboard");
    } catch (err) {
      flash("Copy failed", 2400);
      consoleError(
        `Couldn't copy to the clipboard (${err?.message || "permission denied"}). Select the text in the editor and copy it instead.`,
        "clipboard"
      );
    }
  }

  /* ---------- Canvas drag & drop ---------- */

  window.addEventListener("pointermove", (e) => {
    if (resizeState) {
      const node = getNode(resizeState.id);
      const el = canvasEl.querySelector(`.entity-node[data-id="${resizeState.id}"]`);
      if (!node || !el) return;
      const nextW = Math.max(300, resizeState.startW + (e.clientX - resizeState.startX));
      const nextH = Math.max(160, resizeState.startH + (e.clientY - resizeState.startY));
      node.width = nextW;
      node.height = nextH;
      node.fixedHeight = true;
      el.style.width = `${nextW}px`;
      el.style.height = `${nextH}px`;
      el.style.maxHeight = "";
      updateCanvasSurface();
      return;
    }

    if (!moveState) return;
    const node = getNode(moveState.id);
    const el = canvasEl.querySelector(`.entity-node[data-id="${moveState.id}"]`);
    if (!node || !el) return;

    const canvasRect = canvasEl.getBoundingClientRect();
    node.x = Math.max(
      0,
      e.clientX - canvasRect.left - moveState.offsetX + canvasEl.scrollLeft
    );
    node.y = Math.max(
      0,
      e.clientY - canvasRect.top - moveState.offsetY + canvasEl.scrollTop
    );
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    updateCanvasSurface();
  });

  window.addEventListener("pointerup", () => {
    if (resizeState) {
      const el = canvasEl.querySelector(`.entity-node[data-id="${resizeState.id}"]`);
      if (el) el.classList.remove("resizing");
      document.body.classList.remove("is-resizing-node");
      resizeState = null;
      scheduleSaveWorkspace();
      scheduleHistoryCommit();
      return;
    }
    if (!moveState) return;
    const el = canvasEl.querySelector(`.entity-node[data-id="${moveState.id}"]`);
    if (el) el.classList.remove("dragging");
    document.body.classList.remove("is-dragging-node");
    moveState = null;
    scheduleSaveWorkspace();
    scheduleHistoryCommit();
  });

  canvasEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    canvasEl.classList.add("drag-over");
  });

  canvasEl.addEventListener("dragleave", (e) => {
    if (!canvasEl.contains(e.relatedTarget)) {
      canvasEl.classList.remove("drag-over");
    }
  });

  canvasEl.addEventListener("drop", (e) => {
    e.preventDefault();
    canvasEl.classList.remove("drag-over");
    closeEntityMenu();
    const typeName = dragPaletteType || e.dataTransfer.getData("text/plain");
    if (!typeName || !schema[typeName]) return;

    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasEl.scrollLeft - DEFAULT_NODE_W / 2;
    const y = e.clientY - rect.top + canvasEl.scrollTop - 24;
    placeEntity(typeName, x, y);
  });

  addEntityBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleEntityMenu();
  });
  emptyAddBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEntityMenu();
  });
  document.addEventListener("click", (e) => {
    if (!entityMenuWrap.contains(e.target)) closeEntityMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeEntityMenu();
  });

  clearBtn.addEventListener("click", () => {
    if (!nodes.length) return;
    checkpoint();
    const count = `${nodes.length} block${nodes.length === 1 ? "" : "s"}`;
    nodes = [];
    fieldQueries.clear();
    nodeTabs.clear();
    selectedNodeId = null;
    clearDqlDirty();
    clearWorkspace();
    renderNodes();
    refreshQuery();
    showUndoToast(`Cleared ${count} from the canvas`);
  });

  copyBtn.addEventListener("click", () => copyText(getDqlText(), copyBtn));
  copyVarsBtn.addEventListener("click", () => copyText(varsText, copyVarsBtn));

  /* ---------- DQL editor → canvas ---------- */

  /**
   * Parse DQL text into canvas nodes. Extends the live schema when the query
   * references types/fields that are not loaded yet.
   */
  function importQueryText(raw, { source = "import" } = {}) {
    if (!window.DQLQueryParser) {
      throw new Error("Query parser is not loaded");
    }
    const operations = window.DQLQueryParser.parse(raw);
    const { schema: nextSchema, warnings } = window.DQLQueryParser.ensureSchema(
      schema,
      operations
    );
    const drafts = window.DQLQueryParser.toNodes(operations, nextSchema);

    checkpoint();
    const replaced = nodes.length;
    schema = nextSchema;
    schemaIsSample = false;
    nodes = [];
    selectedNodeId = null;

    drafts.forEach((draft, i) => {
      const withIds = (group) => {
        const g = ensureFilterGroup(group);
        return {
          op: g.op,
          conditions: g.conditions.map((c) => ({
            id: filterUid(),
            func: c.func || "eq",
            predicate: c.predicate || "",
            valueMode: c.valueMode === "param" ? "param" : "literal",
            literal: c.literal ?? "",
            paramName: c.paramName || "",
            varRef: c.varRef || "",
          })),
        };
      };
      const edgeFilters = {};
      Object.entries(draft.edgeFilters || {}).forEach(([key, group]) => {
        edgeFilters[key] = withIds(group);
      });

      const pos = findFreePosition(DEFAULT_NODE_W, DEFAULT_NODE_H);
      nodes.push({
        id: uid(),
        type: draft.type,
        name: draft.name,
        x: pos.x,
        y: pos.y,
        width: DEFAULT_NODE_W,
        height: DEFAULT_NODE_H,
        selection: draft.selection,
        params: (draft.params || []).map((p) => ({
          id: paramUid(),
          name: p.name,
          type: PARAM_TYPES.includes(p.type) ? p.type : "string",
          value: p.value ?? "",
          mode: p.mode === "default" ? "default" : "var",
        })),
        rootFilter: withIds(draft.rootFilter),
        edgeFilters,
        directives: {
          cascade: !!draft.directives?.cascade,
          normalize: !!draft.directives?.normalize,
        },
        aliases: { ...(draft.aliases || {}) },
        resultName: draft.resultName || "",
        varName: draft.varName || "",
        rootVar: draft.rootVar || "",
      });
    });

    if (nodes.length) selectedNodeId = nodes[0].id;
    resolveOverlaps();

    // Clear dirty before refresh so generated DQL can write back into the editor.
    clearDqlDirty();
    renderDock();
    renderNodes();
    refreshQuery();

    consoleInfo(
      `Applied ${nodes.length} query block${nodes.length === 1 ? "" : "s"}`,
      source
    );
    (warnings || []).forEach((w) => consoleWarn(w, source));
    if (replaced) {
      showUndoToast(
        `Replaced ${replaced} block${replaced === 1 ? "" : "s"} with ${nodes.length} from the query`
      );
    } else {
      commitHistory();
    }
    return `Loaded ${nodes.length} query block${nodes.length === 1 ? "" : "s"}`;
  }

  /**
   * Commit the DQL editor buffer to the canvas.
   * @param {{ reason?: string, soft?: boolean }} [opts]
   *   soft — used on blur: skip if not dirty / not a complete-looking query,
   *   and don't log errors for empty buffers.
   */
  function applyDqlFromEditor({ reason = "apply", soft = false } = {}) {
    if (soft && !dqlDirty) return false;

    const text = getDqlText().trim();
    if (!text) {
      if (soft) return false;
      checkpoint();
      const count = nodes.length;
      nodes = [];
      selectedNodeId = null;
      clearDqlDirty();
      renderNodes();
      refreshQuery();
      consoleInfo("Cleared canvas from empty DQL editor", "editor");
      if (count) showUndoToast(`The query was empty, so the canvas was cleared (${count} block${count === 1 ? "" : "s"})`);
      return true;
    }

    if (!looksLikeDql(text)) {
      if (soft) return false;
      consoleError(
        "Expected one or more `query Name { … }` operations before applying",
        "editor"
      );
      return false;
    }

    // No-op if the buffer still matches the last generated output.
    if (text === queryText.trim()) {
      clearDqlDirty();
      return true;
    }

    try {
      importQueryText(text, { source: "editor" });
      return true;
    } catch (err) {
      // The marker shows either way; soft blur stays quiet in the console while the user is still typing.
      markDqlError(err);
      if (!soft) consoleError(err.message || String(err), "editor");
      if (!dqlDirty) {
        dqlDirty = true;
        updateDqlChrome();
      }
      return false;
    }
  }

  function revertDqlEditor() {
    clearDqlDirty();
    writeDqlEditor(queryText);
    copyBtn.disabled = !queryText;
    consoleInfo("Reverted DQL editor to last canvas output", "editor");
  }

  applyDqlBtn.addEventListener("click", () => applyDqlFromEditor({ reason: "button" }));
  revertDqlBtn.addEventListener("click", () => revertDqlEditor());

  // Ctrl/Cmd+V on the canvas loads a pasted query directly.
  canvasEl.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain") || "";
    if (!looksLikeDql(text)) return;
    if (e.target.closest("input, textarea, select, .monaco-editor")) return;
    e.preventDefault();
    try {
      importQueryText(text, { source: "paste" });
    } catch (err) {
      // Drop the text into the DQL editor so the user can fix it.
      clearDqlDirty();
      writeDqlEditor(text);
      markDqlDirty();
      consoleError(err.message || String(err), "paste");
    }
  });

  /* ---------- Schema loading ---------- */

  const schemaModal = document.getElementById("schemaModal");
  const loadSchemaBtn = document.getElementById("loadSchemaBtn");
  const schemaUrlInput = document.getElementById("schemaUrl");
  const schemaFetchBtn = document.getElementById("schemaFetchBtn");
  const schemaTextInput = document.getElementById("schemaText");
  const schemaApplyBtn = document.getElementById("schemaApplyBtn");
  const schemaSampleBtn = document.getElementById("schemaSampleBtn");
  const schemaCloseBtn = document.getElementById("schemaCloseBtn");
  const schemaStatus = document.getElementById("schemaStatus");

  function setSchemaStatus(message, kind) {
    schemaStatus.textContent = message;
    schemaStatus.className = `modal-status${kind ? ` is-${kind}` : ""}`;
  }

  /**
   * Swap the active schema and reset the canvas (blocks reference old types).
   * Undo brings back the previous schema together with its blocks.
   */
  function setSchema(next, { isSample = false, message = "" } = {}) {
    checkpoint();
    const cleared = nodes.length;
    schema = next;
    schemaIsSample = isSample;
    nodes = [];
    selectedNodeId = null;
    clearDqlDirty();
    renderDock();
    renderNodes();
    refreshQuery();
    if (cleared) {
      showUndoToast(`${message}; cleared ${cleared} block${cleared === 1 ? "" : "s"}`);
    } else {
      commitHistory();
    }
  }

  function applyLoadedSchema(next, sourceLabel) {
    const count = Object.keys(next).length;
    if (!count) {
      setSchemaStatus("Schema parsed, but it contains no usable object types.", "error");
      consoleError("Schema parsed, but it contains no usable object types.", "schema");
      return;
    }
    const message = `Loaded ${count} entit${count === 1 ? "y" : "ies"} from ${sourceLabel}`;
    closeSchemaModal();
    setSchema(next, { isSample: false, message });
    consoleInfo(message, "schema");
  }

  function openSchemaModal() {
    schemaModal.hidden = false;
    setSchemaStatus("", "");
    schemaUrlInput.focus();
  }

  function closeSchemaModal() {
    schemaModal.hidden = true;
    loadSchemaBtn.focus();
  }

  loadSchemaBtn.addEventListener("click", openSchemaModal);
  schemaCloseBtn.addEventListener("click", closeSchemaModal);
  schemaModal.addEventListener("click", (e) => {
    if (e.target === schemaModal) closeSchemaModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!schemaModal.hidden) closeSchemaModal();
  });

  schemaFetchBtn.addEventListener("click", async () => {
    const url = schemaUrlInput.value.trim();
    if (!url) {
      setSchemaStatus("Enter the Dgraph Alpha URL first.", "error");
      consoleError("Enter the Dgraph Alpha URL first.", "schema");
      return;
    }
    schemaFetchBtn.disabled = true;
    setSchemaStatus("Fetching schema…", "");
    try {
      const next = await window.DQLSchemaLoader.fetchSchema(url);
      applyLoadedSchema(next, "endpoint");
    } catch (err) {
      setSchemaStatus(`Failed: ${err.message}`, "error");
      consoleError(err.message || String(err), "schema");
    } finally {
      schemaFetchBtn.disabled = false;
    }
  });

  schemaUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      schemaFetchBtn.click();
    }
  });

  schemaApplyBtn.addEventListener("click", () => {
    try {
      const next = window.DQLSchemaLoader.fromText(schemaTextInput.value);
      applyLoadedSchema(next, "pasted schema");
    } catch (err) {
      setSchemaStatus(`Failed: ${err.message}`, "error");
      consoleError(err.message || String(err), "schema");
    }
  });

  schemaSampleBtn.addEventListener("click", () => {
    closeSchemaModal();
    setSchema(window.DQL_SCHEMA, { isSample: true, message: "Switched to the sample schema" });
    consoleInfo("Switched to the built-in sample schema", "schema");
  });

  /* ---------- Resizable query pane ---------- */

  const SPLIT_KEY = "dql-builder:query-width";

  function setQueryWidth(px) {
    const total = workspaceEl.clientWidth;
    const clamped = Math.round(Math.max(280, Math.min(total - 360, px)));
    workspaceEl.style.setProperty("--query-w", `${clamped}px`);
    return clamped;
  }

  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved) setQueryWidth(saved);
  } catch {
    /* storage unavailable */
  }

  function saveQueryWidth() {
    const w = workspaceEl.querySelector(".query-pane").offsetWidth;
    try {
      localStorage.setItem(SPLIT_KEY, String(w));
    } catch {
      /* storage unavailable */
    }
  }

  splitterEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitterEl.setPointerCapture(e.pointerId);
    document.body.classList.add("is-splitting");
    const left = workspaceEl.getBoundingClientRect().left;
    const onMove = (ev) => setQueryWidth(ev.clientX - left);
    const onUp = () => {
      splitterEl.removeEventListener("pointermove", onMove);
      splitterEl.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-splitting");
      saveQueryWidth();
    };
    splitterEl.addEventListener("pointermove", onMove);
    splitterEl.addEventListener("pointerup", onUp);
  });

  splitterEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = workspaceEl.querySelector(".query-pane").offsetWidth;
    setQueryWidth(current + (e.key === "ArrowRight" ? 24 : -24));
    saveQueryWidth();
  });

  /* ---------- Help ---------- */

  const helpBtn = document.getElementById("helpBtn");
  const helpPanel = document.getElementById("helpPanel");
  const helpWrap = document.getElementById("helpWrap");

  function setHelpOpen(open) {
    helpPanel.hidden = !open;
    helpBtn.setAttribute("aria-expanded", String(open));
  }

  helpBtn.addEventListener("click", () => setHelpOpen(helpPanel.hidden));
  document.addEventListener("click", (e) => {
    if (!helpPanel.hidden && !helpWrap.contains(e.target)) setHelpOpen(false);
  });
  helpWrap.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || helpPanel.hidden) return;
    e.stopPropagation();
    setHelpOpen(false);
    helpBtn.focus();
  });

  document.querySelectorAll(".mod-key").forEach((el) => {
    el.textContent = MOD_KEY;
  });

  /* ---------- Theme ---------- */

  const THEME_KEY = "dql-builder:theme";
  const themeBtn = document.getElementById("themeBtn");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function monacoThemeName() {
    return currentTheme() === "dark" ? "dql-dark" : "dql-light";
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
    themeBtn.title = label;
    themeBtn.setAttribute("aria-label", label);
    if (typeof monaco !== "undefined") monaco.editor.setTheme(monacoThemeName());
  }

  themeBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable */
    }
    applyTheme(next);
  });

  // Follow the OS setting until the user picks a theme explicitly.
  darkQuery.addEventListener("change", (e) => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* storage unavailable */
    }
    if (!saved) applyTheme(e.matches ? "dark" : "light");
  });

  applyTheme(currentTheme());

  /* ---------- Init ---------- */

  const restored = restoreWorkspace();
  renderDock();
  if (restored) {
    renderNodes();
    consoleInfo("Restored canvas from previous session", "workspace");
  } else {
    updateEmptyState();
  }
  initEditors();
  refreshQuery();
  commitHistory();
  updateHistoryButtons();
})();
