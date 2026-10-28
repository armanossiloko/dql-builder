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
  ];

  function isUnaryFilter(func) {
    const f = String(func || "").replace(/^not\s+/i, "").toLowerCase();
    return f === "has";
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

  const ICON_CLOSE =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>';

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
   *   rootFilter: FilterGroup, edgeFilters: Record<string, FilterGroup>
   * }} QueryNode
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

  function initEditors() {
    if (!window.require) {
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
          { token: "comment", foreground: "686b74", fontStyle: "italic" },
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
          { token: "comment", foreground: "8b909a", fontStyle: "italic" },
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
    });
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

  function newFilterCondition(predicate = "", typeHint = "string") {
    return {
      id: filterUid(),
      func: "eq",
      predicate,
      valueMode: "literal",
      literal: defaultParamValue(typeHint),
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
  const NODE_GAP = 28;
  const CANVAS_PAD = 48;
  const CANVAS_MIN_W = 3200;
  const CANVAS_MIN_H = 2400;

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

  function updateCanvasSurface() {
    if (!canvasSurfaceEl) return;
    let maxR = CANVAS_MIN_W;
    let maxB = CANVAS_MIN_H;
    nodes.forEach((n) => {
      const s = estimateNodeSize(n);
      maxR = Math.max(maxR, n.x + s.w + 600);
      maxB = Math.max(maxB, n.y + s.h + 600);
    });
    // Also account for live DOM sizes when available.
    canvasEl.querySelectorAll(".entity-node").forEach((el) => {
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      maxR = Math.max(maxR, x + el.offsetWidth + 600);
      maxB = Math.max(maxB, y + el.offsetHeight + 600);
    });
    canvasSurfaceEl.style.width = `${Math.ceil(maxR)}px`;
    canvasSurfaceEl.style.height = `${Math.ceil(maxB)}px`;
  }

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

  function renderNodeTabs(node, activeTab) {
    const counts = {
      fields: countSelected(node.selection),
      filter: ensureFilterGroup(node.rootFilter).conditions.length,
      variables: (node.params || []).length,
    };
    return NODE_TABS.map((tab) => {
      const active = tab.id === activeTab;
      const count = counts[tab.id];
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
        >${tab.label}${count ? `<span class="tab-count">${count}</span>` : ""}</button>
      `;
    }).join("");
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

  function renderFilterValueControls(cond, params) {
    if (isUnaryFilter(cond.func)) {
      return `<span class="filter-value-blank" title="${escapeAttr(cond.func)} takes no value">No value needed</span>`;
    }

    const isParam = cond.valueMode === "param";
    const toggle = `
      <button
        type="button"
        class="filter-value-mode"
        aria-pressed="${isParam}"
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

    return `
      <div class="filter-value">
        ${toggle}
        <input type="text" class="filter-literal" value="${escapeAttr(cond.literal || "")}" placeholder="value" spellcheck="false" aria-label="Value" />
      </div>
    `;
  }

  function renderFilterGroupPanel(group, typeName, params, { edgePath = "", title = "", emptyText = "" } = {}) {
    const g = ensureFilterGroup(group);
    const preds = scalarOptionsForType(typeName);
    const rows = g.conditions
      .map(
        (cond) => `
          <div class="filter-row" data-filter-id="${cond.id}">
            <select class="filter-predicate" aria-label="Predicate">${optionsHtml(
              preds.length ? preds : [{ value: "", label: "—" }],
              cond.predicate || ""
            )}</select>
            <select class="filter-func" aria-label="Function">${optionsHtml(FILTER_FUNCS, cond.func || "eq")}</select>
            ${renderFilterValueControls(cond, params)}
            <button type="button" class="btn-icon is-danger filter-remove" title="Remove condition" aria-label="Remove condition">${ICON_CLOSE}</button>
          </div>
        `
      )
      .join("");

    const opToggle =
      g.conditions.length > 1
        ? `
          <div class="segmented" role="group" aria-label="Combine conditions with">
            <button type="button" class="filter-op-btn${g.op !== "OR" ? " active" : ""}" data-op="AND" title="Match all conditions">AND</button>
            <button type="button" class="filter-op-btn${g.op === "OR" ? " active" : ""}" data-op="OR" title="Match any condition">OR</button>
          </div>
        `
        : "";

    return `
      <div class="filter-panel${edgePath ? " is-edge" : ""}" data-edge-path="${escapeAttr(edgePath)}">
        <div class="section-head">
          ${title ? `<span class="section-title">${escapeAttr(title)}</span>` : ""}
          ${opToggle}
          <button type="button" class="btn btn-quiet btn-sm push add-filter">+ Add condition</button>
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
            edgeFilterHtml = renderFilterGroupPanel(edgeGroup, field.ofType, node.params, {
              edgePath: key,
              title: `Filter ${label}`,
            });
          } else {
            edgeFilterBtn = `<button type="button" class="field-filter-btn add-edge-filter" data-edge-path="${escapeAttr(key)}" title="Filter the ${escapeAttr(label)} edge">+ Filter</button>`;
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
          <button type="button" class="btn btn-quiet btn-sm push add-param">+ Add variable</button>
        </div>
        ${head}${rows || '<p class="section-empty">Variables become $name in the query and can be used as filter values.</p>'}
      </div>
    `;
  }

  function renderRootFiltersSection(node) {
    return `
      <div class="node-section filters-section">
        ${renderFilterGroupPanel(node.rootFilter, node.type, node.params, {
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
    return `
      <div class="node-section">
        <div class="kv">
          <label class="kv-label" for="${node.id}-name">Name</label>
          <input
            type="text"
            id="${node.id}-name"
            class="query-name-input"
            value="${escapeAttr(node.name)}"
            spellcheck="false"
            title="Operation name: query <name>"
          />
          <label class="kv-label" for="${node.id}-result">Result key</label>
          <input
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

  function renderNodes() {
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

    canvasEl.querySelectorAll(".entity-node").forEach((el) => el.remove());

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
      el.style.height = `${size.h}px`;
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
        <header class="entity-node-header" data-drag-handle title="Drag to move">
          <span class="dot" style="background:${dotColor(def.color)}"></span>
          <span class="entity-type-label">${escapeAttr(node.type)}</span>
          <span class="entity-node-name">${escapeAttr(node.name)}</span>
          <button type="button" class="btn-icon is-danger entity-node-remove" title="Remove block" aria-label="Remove ${escapeAttr(node.type)} block">${ICON_CLOSE}</button>
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
        if (e.target.closest(".entity-node-remove")) return;
        e.preventDefault();
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

      el.querySelector(".entity-node-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        nodes = nodes.filter((n) => n.id !== node.id);
        fieldQueries.delete(node.id);
        nodeTabs.delete(node.id);
        if (selectedNodeId === node.id) selectedNodeId = null;
        renderNodes();
        refreshQuery();
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
        group.conditions.push(
          newFilterCondition(predName, paramTypeForPredicate(typeName, predName))
        );
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
          const paramEl = row.querySelector(".filter-param");
          const removeBtn = row.querySelector(".filter-remove");

          [funcEl, predEl, modeEl, literalEl, paramEl, removeBtn]
            .filter(Boolean)
            .forEach(stopDragPropagation);

          funcEl?.addEventListener("change", () => {
            cond.func = funcEl.value;
            if (isUnaryFilter(cond.func)) {
              cond.valueMode = "literal";
              cond.literal = "";
              cond.paramName = "";
            }
            renderNodes();
            refreshQuery();
          });
          predEl?.addEventListener("change", () => {
            cond.predicate = predEl.value;
            const type = paramTypeForPredicate(typeName, cond.predicate);
            if (cond.valueMode === "literal" && !isUnaryFilter(cond.func)) {
              cond.literal = defaultParamValue(type);
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
            refreshQuery();
          });
          paramEl?.addEventListener("change", () => {
            cond.paramName = paramEl.value;
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

          if (input.checked) {
            if (kind === "object") {
              current.selection = setAtPath(current.selection, path, {});
            } else {
              current.selection = setAtPath(current.selection, path, null);
            }
          } else {
            current.selection = setAtPath(current.selection, path, undefined);
            const pathStr = pathKey(path);
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
        });
      });

      el.addEventListener("mousedown", (e) => {
        if (e.target.closest("input, label, button, select")) return;
        setSelected(node.id);
      });

      canvasEl.appendChild(el);
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

  function collectParams(roots) {
    const map = new Map();
    roots.forEach((node) => {
      (node.params || []).forEach((param) => {
        if (param.mode === "literal") return;
        const name = sanitizeName(param.name, "");
        if (!name || map.has(name)) return;
        map.set(name, { ...param, name });
      });
    });
    return [...map.values()];
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

  function formatFilterCondition(cond, typeName) {
    if (!cond?.func || !cond?.predicate) return null;
    if (isUnaryFilter(cond.func)) return `${cond.func}(${cond.predicate})`;

    if (cond.valueMode === "param") {
      const name = sanitizeName(cond.paramName, "");
      if (!name) return null;
      return `${cond.func}(${cond.predicate}, $${name})`;
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

  function refreshQuery() {
    try {
      const roots = nodes.filter((n) => hasAnySelection(n.selection));
      if (!roots.length) {
        setOutputs(
          nodes.length ? "# Pick at least one predicate on a query block." : "",
          ""
        );
        return;
      }

      const names = uniqueBlockNames(roots);
      const allParams = collectParams(roots);

      // One named operation per canvas block, each with its own signature.
      const operations = roots.map((node, i) => {
        const filter = formatFilterDirective(node.rootFilter, node.type);
        const directives =
          (node.directives?.cascade ? " @cascade" : "") +
          (node.directives?.normalize ? " @normalize" : "");
        const body = renderSelection(
          node.type,
          node.selection,
          2,
          node,
          "",
          node.aliases || {}
        );

        const params = blockParams(node);
        const signature = params.length
          ? `(${params
              .map(
                (p) =>
                  `$${p.name}: ${p.type}${p.mode === "default" ? ` = ${formatDqlLiteral(p)}` : ""}`
              )
              .join(", ")})`
          : "";
        const inner = sanitizeName(node.resultName, "") || innerBlockName(names[i]);

        return (
          `query ${names[i]}${signature} {\n` +
          `${indent(1)}${inner}(func: type("${node.type}"))${filter}${directives} {\n` +
          `${body}\n${indent(1)}}\n}`
        );
      });

      // Single block → flat vars object; multiple → grouped per operation,
      // since each operation is executed separately with its own variables.
      let vars = "";
      if (allParams.length) {
        const varsFor = (node) => {
          const obj = {};
          blockParams(node).forEach((p) => {
            obj[`$${p.name}`] = formatParamValue(p);
          });
          return obj;
        };

        if (roots.length === 1) {
          vars = JSON.stringify(varsFor(roots[0]), null, 2);
        } else {
          const grouped = {};
          roots.forEach((node, i) => {
            if (blockParams(node).length) grouped[names[i]] = varsFor(node);
          });
          vars = JSON.stringify(grouped, null, 2);
        }
      }

      setOutputs(operations.join("\n\n"), vars);
    } catch (err) {
      consoleError(err.message || String(err), "query-build");
      setOutputs(`# Query build failed:\n# ${err.message || err}`, "");
    } finally {
      scheduleSaveWorkspace();
    }
  }

  /* ---------- Copy ---------- */

  async function copyText(text, button) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = prev;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  /* ---------- Canvas drag & drop ---------- */

  window.addEventListener("pointermove", (e) => {
    if (resizeState) {
      const node = getNode(resizeState.id);
      const el = canvasEl.querySelector(`.entity-node[data-id="${resizeState.id}"]`);
      if (!node || !el) return;
      const nextW = Math.max(300, resizeState.startW + (e.clientX - resizeState.startX));
      const nextH = Math.max(240, resizeState.startH + (e.clientY - resizeState.startY));
      node.width = nextW;
      node.height = nextH;
      el.style.width = `${nextW}px`;
      el.style.height = `${nextH}px`;
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
      return;
    }
    if (!moveState) return;
    const el = canvasEl.querySelector(`.entity-node[data-id="${moveState.id}"]`);
    if (el) el.classList.remove("dragging");
    document.body.classList.remove("is-dragging-node");
    moveState = null;
    scheduleSaveWorkspace();
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
    const count = `${nodes.length} block${nodes.length === 1 ? "" : "s"}`;
    if (!window.confirm(`Remove all ${count} from the canvas?`)) return;
    nodes = [];
    fieldQueries.clear();
    nodeTabs.clear();
    selectedNodeId = null;
    clearDqlDirty();
    clearWorkspace();
    renderNodes();
    refreshQuery();
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
      nodes = [];
      selectedNodeId = null;
      clearDqlDirty();
      renderNodes();
      refreshQuery();
      consoleInfo("Cleared canvas from empty DQL editor", "editor");
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
      // Soft blur: stay dirty quietly while the user is still typing.
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

  /** Swap the active schema and reset the canvas (blocks reference old types). */
  function setSchema(next, { isSample = false } = {}) {
    schema = next;
    schemaIsSample = isSample;
    nodes = [];
    selectedNodeId = null;
    clearDqlDirty();
    renderDock();
    renderNodes();
    refreshQuery();
  }

  function applyLoadedSchema(next, sourceLabel) {
    const count = Object.keys(next).length;
    if (!count) {
      setSchemaStatus("Schema parsed, but it contains no usable object types.", "error");
      consoleError("Schema parsed, but it contains no usable object types.", "schema");
      return;
    }
    if (!confirmCanvasReset()) return;
    setSchema(next, { isSample: false });
    consoleInfo(`Loaded ${count} entit${count === 1 ? "y" : "ies"} from ${sourceLabel}`, "schema");
    closeSchemaModal();
  }

  /** Switching schema empties the canvas — ask first if there is work on it. */
  function confirmCanvasReset() {
    if (!nodes.length) return true;
    return window.confirm(
      `Loading a schema clears the canvas (${nodes.length} block${nodes.length === 1 ? "" : "s"}). Continue?`
    );
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
    if (!confirmCanvasReset()) return;
    setSchema(window.DQL_SCHEMA, { isSample: true });
    consoleInfo("Switched to the built-in sample schema", "schema");
    closeSchemaModal();
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
})();
