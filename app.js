(() => {
  let schema = window.DQL_SCHEMA;
  const PARAM_TYPES = ["string", "int", "float", "bool"];
  const FILTER_FUNCS = [
    { value: "", label: "no filter" },
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

  const dockEl = document.getElementById("entityDock");
  const canvasEl = document.getElementById("canvas");
  const canvasEmptyEl = document.getElementById("canvasEmpty");
  const copyBtn = document.getElementById("copyBtn");
  const copyVarsBtn = document.getElementById("copyVarsBtn");
  const clearBtn = document.getElementById("clearBtn");
  const applyDqlBtn = document.getElementById("applyDqlBtn");
  const revertDqlBtn = document.getElementById("revertDqlBtn");
  const dqlDirtyBadge = document.getElementById("dqlDirtyBadge");
  const dqlEditHint = document.getElementById("dqlEditHint");
  const consoleOutputEl = document.getElementById("consoleOutput");
  const consoleFilterEl = document.getElementById("consoleFilter");
  const consoleLevelEl = document.getElementById("consoleLevel");
  const consoleClearBtn = document.getElementById("consoleClearBtn");
  const consoleErrorCountEl = document.getElementById("consoleErrorCount");
  const consoleWarnCountEl = document.getElementById("consoleWarnCount");

  /**
   * Each canvas node is one DQL query block.
   * `selection` tree: { predicate: null | { nested… } }
   * Each param owns its filter binding (func + predicate).
   * @typedef {{ id: string, name: string, type: string, value: string, func: string, predicate: string }} Param
   * @typedef {{
   *   id: string, type: string, name: string, x: number, y: number,
   *   selection: Record<string, any>, params: Param[]
   * }} QueryNode
   * @type {QueryNode[]}
   */
  let nodes = [];
  let dragPaletteType = null;
  /** @type {{ id: string, offsetX: number, offsetY: number } | null} */
  let moveState = null;
  let selectedNodeId = null;
  let nodeSeq = 0;
  let paramSeq = 0;
  const animatedNodes = new Set();

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
    const q = (consoleFilterEl.value || "").trim().toLowerCase();
    const level = consoleLevelEl.value || "all";
    consoleOutputEl.querySelectorAll(".console-row").forEach((row) => {
      const rowLevel = row.dataset.level;
      const text = row.dataset.text || "";
      const levelOk = level === "all" || rowLevel === level;
      const textOk = !q || text.includes(q);
      row.classList.toggle("is-hidden", !(levelOk && textOk));
    });
  }

  function updateConsoleCounts() {
    const errors = consoleEntries.filter((e) => e.level === "error").length;
    const warns = consoleEntries.filter((e) => e.level === "warn").length;
    consoleErrorCountEl.querySelector(".console-count-num").textContent = String(errors);
    consoleWarnCountEl.querySelector(".console-count-num").textContent = String(warns);
  }

  function renderConsoleEmpty() {
    if (consoleEntries.length) return;
    consoleOutputEl.innerHTML =
      '<p class="console-empty">Console cleared — parse and build messages will appear here.</p>';
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
    row.dataset.text = `${entry.message} ${entry.source}`.toLowerCase();
    row.innerHTML = `
      <span class="console-row-icon" aria-hidden="true"></span>
      <span class="console-row-msg"></span>
      <span class="console-row-source"></span>
    `;
    row.querySelector(".console-row-msg").textContent = entry.message;
    row.querySelector(".console-row-source").textContent = entry.source;
    consoleOutputEl.appendChild(row);
    consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;

    updateConsoleCounts();
    applyConsoleFilters();
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
  consoleFilterEl.addEventListener("input", applyConsoleFilters);
  consoleLevelEl.addEventListener("change", applyConsoleFilters);
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
      "font-family:var(--mono);font-size:0.82rem;line-height:1.55;color:var(--ink);background:transparent;";
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
      monaco.editor.defineTheme("dql-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "keyword", foreground: "3dd68c", fontStyle: "bold" },
          { token: "string", foreground: "fdd663" },
          { token: "number", foreground: "8ab4f8" },
          { token: "comment", foreground: "9aa0a6", fontStyle: "italic" },
        ],
        colors: {
          "editor.background": "#202124",
          "editor.foreground": "#e8eaed",
          "editor.lineHighlightBackground": "#292a2d",
          "editorLineNumber.foreground": "#5f6368",
          "editorGutter.background": "#202124",
          "editorCursor.foreground": "#e8eaed",
          "editor.selectionBackground": "#3c4043",
          "editor.inactiveSelectionBackground": "#303134",
          "editorWidget.background": "#292a2d",
          "editorWidget.border": "#3c4043",
          "input.background": "#1a1b1e",
          "dropdown.background": "#292a2d",
        },
      });

      const common = {
        theme: "dql-dark",
        minimap: { enabled: false },
        automaticLayout: true,
        fontFamily: "IBM Plex Mono, ui-monospace, monospace",
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 12, bottom: 12 },
        wordWrap: "on",
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
    let targets = scalarPredicates(typeName).map((f) => ({
      value: [...prefix, f.name].join("."),
      label: [...prefix, f.name].join("."),
    }));

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

  function updateEmptyState() {
    canvasEmptyEl.classList.toggle("hidden", nodes.length > 0);
    if (!nodes.length) {
      canvasEmptyEl.textContent =
        "Edit DQL on the left, or click / drag an entity from the dock.";
    }
  }

  function stopDragPropagation(el) {
    ["pointerdown", "mousedown", "click"].forEach((evt) => {
      el.addEventListener(evt, (e) => e.stopPropagation());
    });
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
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

  /* ---------- Entity dock ---------- */

  function renderDock() {
    dockEl.innerHTML = '<p class="dock-title">Entities</p>';
    Object.entries(schema).forEach(([typeName, def]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dock-item";
      item.draggable = true;
      item.dataset.type = typeName;
      item.title = `Add ${typeName} query block`;
      item.innerHTML = `
        <span class="palette-dot" style="background:${def.color}"></span>
        <span>${typeName}</span>
        <span class="dock-add" aria-hidden="true" title='type("${typeName}")'>+</span>
      `;
      item.addEventListener("click", () => {
        const count = nodes.length;
        placeEntity(typeName, 200 + (count % 5) * 30, 30 + (count % 5) * 30);
      });
      item.addEventListener("dragstart", (e) => {
        dragPaletteType = typeName;
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", typeName);
      });
      item.addEventListener("dragend", () => {
        dragPaletteType = null;
        item.classList.remove("dragging");
      });
      dockEl.appendChild(item);
    });
  }

  /* ---------- Query block rendering ---------- */

  function renderFieldTree(typeName, selection, path, depth, aliases) {
    const def = schema[typeName];
    if (!def) return "";

    return def.fields
      .map((field) => {
        const fieldPath = [...path, field.name];
        const key = pathKey(fieldPath);
        const checked = isSelected(selection, fieldPath);
        const isObject = field.kind === "object";
        const objectClass = isObject ? " is-object" : "";

        let nestedHtml = "";
        if (isObject && checked && field.ofType && schema[field.ofType] && depth < 8) {
          nestedHtml = `
            <ul class="nested-fields" data-depth="${depth + 1}">
              ${renderFieldTree(field.ofType, selection, fieldPath, depth + 1, aliases)}
            </ul>
          `;
        }

        const aliasValue = aliases[key] || "";
        const aliasHtml = checked
          ? `<input
              type="text"
              class="alias-input"
              data-alias-path="${escapeAttr(encodePath(fieldPath))}"
              value="${escapeAttr(aliasValue)}"
              size="${Math.max(5, Math.min(28, (aliasValue || "alias").length + 1))}"
              placeholder="alias"
              spellcheck="false"
              title="Alias — result key for this predicate"
            />`
          : `<span class="field-type">${field.type}</span>`;

        return `
          <li>
            <div class="field-row${objectClass}" style="padding-left:${0.4 + depth * 0.55}rem">
              <label class="field-check">
                <input
                  type="checkbox"
                  data-path="${escapeAttr(encodePath(fieldPath))}"
                  data-kind="${field.kind}"
                  data-oftype="${field.ofType || ""}"
                  ${checked ? "checked" : ""}
                />
                <span class="field-name">${field.name}</span>
              </label>
              ${aliasHtml}
            </div>
            ${nestedHtml}
          </li>
        `;
      })
      .join("");
  }

  function optionsHtml(items, selected) {
    const list = items.slice();
    if (selected != null && selected !== "" && !list.some((item) => item.value === selected)) {
      list.push({ value: selected, label: selected });
    }
    return list
      .map(
        (item) =>
          `<option value="${item.value}" ${item.value === selected ? "selected" : ""}>${item.label}</option>`
      )
      .join("");
  }

  function renderParamsSection(node) {
    const preds = filterTargets(node.type, node.selection);

    const rows = (node.params || [])
      .map((param) => {
        const typeOpts = PARAM_TYPES.map((t) => ({ value: t, label: t }));
        const unary = isUnaryFilter(param.func);
        return `
          <div class="param-card" data-param-id="${param.id}">
            <div class="param-main">
              <input type="text" class="param-name" value="${escapeAttr(param.name)}" placeholder="name" spellcheck="false" title="Parameter name" ${param.mode === "literal" || unary ? "disabled" : ""} />
              <select class="param-type" title="Parameter type" ${unary ? "disabled" : ""}>${optionsHtml(typeOpts, param.type)}</select>
              <input type="text" class="param-value" value="${escapeAttr(param.value)}" placeholder="${unary ? "—" : "value"}" spellcheck="false" title="Sample value" ${unary ? "disabled" : ""} />
              <button type="button" class="param-remove" title="Remove parameter" aria-label="Remove parameter">×</button>
            </div>
            <div class="param-filter">
              <select class="param-func" title="Filter function">${optionsHtml(FILTER_FUNCS, param.func)}</select>
              <select class="param-predicate" title="Predicate" ${param.func ? "" : "disabled"}>
                ${optionsHtml(preds.length ? preds : [{ value: "", label: "—" }], param.predicate)}
              </select>
              <select class="param-mode" title="How the value is passed: $variable, $variable with a default in the signature, or an inline literal (no variable)" ${unary ? "disabled" : ""}>
                ${optionsHtml(
                  [
                    { value: "var", label: "$var" },
                    { value: "default", label: "$ = def" },
                    { value: "literal", label: "literal" },
                  ],
                  unary ? "literal" : param.mode || "var"
                )}
              </select>
            </div>
          </div>
        `;
      })
      .join("");

    return `
      <div class="block-section params-section">
        <div class="block-section-head">
          <span class="block-section-title">Parameters</span>
          <button type="button" class="btn-mini add-param">+ Add</button>
        </div>
        ${rows || '<p class="param-empty">No $params — add one to filter this block</p>'}
      </div>
    `;
  }

  function renderDirectivesSection(node) {
    const toggle = (key) => `
      <button
        type="button"
        class="directive-toggle${node.directives?.[key] ? " active" : ""}"
        data-directive="${key}"
        title="Toggle @${key} on this query block"
      >@${key}</button>
    `;
    return `
      <div class="block-section directives-section">
        <div class="block-section-head no-margin">
          <span class="block-section-title">Directives</span>
          <div class="directive-toggles">
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
      const fields = el.querySelector(".entity-fields");
      if (id && fields) {
        fieldScroll.set(id, { top: fields.scrollTop, left: fields.scrollLeft });
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

      // Pop-in only on first appearance, not on every re-render.
      if (animatedNodes.has(node.id)) el.style.animation = "none";
      else animatedNodes.add(node.id);

      el.innerHTML = `
        <header class="entity-node-header" data-drag-handle>
          <span class="dot" style="background:${def.color}"></span>
          <div class="entity-node-meta">
            <span class="entity-type-label">${node.type}</span>
            <input
              type="text"
              class="query-name-input"
              value="${escapeAttr(node.name)}"
              spellcheck="false"
              aria-label="Query name"
              title="Operation name (query <name>)"
            />
            <input
              type="text"
              class="result-name-input"
              value="${escapeAttr(node.resultName || "")}"
              placeholder="${escapeAttr(innerBlockName(sanitizeName(node.name, `get${node.type}`)))}"
              spellcheck="false"
              aria-label="Result key"
              title="Result key — the inner block name (defaults to the operation name without 'get')"
            />
          </div>
          <button type="button" class="entity-node-remove" title="Remove" aria-label="Remove ${node.type}">×</button>
        </header>
        ${renderDirectivesSection(node)}
        ${renderParamsSection(node)}
        <ul class="entity-fields">${renderFieldTree(node.type, node.selection, [], 0, node.aliases || {})}</ul>
      `;

      const header = el.querySelector(".entity-node-header");
      const nameInput = el.querySelector(".query-name-input");

      header.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".entity-node-remove, .query-name-input, .result-name-input")) return;
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

      stopDragPropagation(nameInput);
      nameInput.addEventListener("input", () => {
        node.name = nameInput.value;
        refreshQuery();
      });
      nameInput.addEventListener("change", () => {
        node.name = sanitizeName(nameInput.value, defaultName(node.type));
        nameInput.value = node.name;
        refreshQuery();
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
        e.stopPropagation();
      });

      const resultInput = el.querySelector(".result-name-input");
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
          refreshQuery();
        });
      });

      el.querySelector(".add-param").addEventListener("click", (e) => {
        e.stopPropagation();
        const preds = scalarPredicates(node.type);
        const used = new Set(node.params.map((p) => p.predicate));
        const nextPred = preds.find((p) => !used.has(p.name)) || preds[0];
        const predName = nextPred?.name || "value";
        const type = paramTypeForPredicate(node.type, predName);

        let name = sanitizeName(predName, `param${node.params.length + 1}`);
        let i = 2;
        while (node.params.some((p) => p.name === name)) {
          name = `${sanitizeName(predName, "param")}${i}`;
          i += 1;
        }

        node.params.push({
          id: paramUid(),
          name,
          type,
          value: defaultParamValue(type),
          func: "eq",
          predicate: predName,
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
        const removeBtn = card.querySelector(".param-remove");
        const funcEl = card.querySelector(".param-func");
        const predEl = card.querySelector(".param-predicate");
        const modeEl = card.querySelector(".param-mode");

        [nameEl, typeEl, valueEl, removeBtn, funcEl, predEl, modeEl].forEach(stopDragPropagation);

        modeEl.addEventListener("change", () => {
          param.mode = modeEl.value;
          renderNodes();
          refreshQuery();
        });

        nameEl.addEventListener("input", () => {
          param.name = nameEl.value.replace(/^\$/, "");
          refreshQuery();
        });
        nameEl.addEventListener("change", () => {
          param.name = sanitizeName(param.name, "param");
          nameEl.value = param.name;
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
        funcEl.addEventListener("change", () => {
          param.func = funcEl.value;
          if (param.func && !param.predicate) {
            param.predicate = scalarPredicates(node.type)[0]?.name || "";
          }
          if (isUnaryFilter(param.func)) {
            param.mode = "literal";
            param.value = "";
          }
          renderNodes();
          refreshQuery();
        });
        predEl.addEventListener("change", () => {
          const oldWalk = splitPredicatePath(node.type, param.predicate);
          const oldLeaf = oldWalk?.leaf || param.predicate.split(".").pop();
          param.predicate = predEl.value;
          // Keep the param type in sync with the bound predicate.
          param.type = paramTypeForPredicate(node.type, param.predicate);
          // If the name was auto-derived from the old predicate, follow the new one.
          const newWalk = splitPredicatePath(node.type, param.predicate);
          const newLeaf = newWalk?.leaf || param.predicate.split(".").pop();
          if (param.name === oldLeaf) {
            let name = sanitizeName(newLeaf, param.name);
            let i = 2;
            while (node.params.some((p) => p !== param && p.name === name)) {
              name = `${sanitizeName(newLeaf, "param")}${i}`;
              i += 1;
            }
            param.name = name;
            if (!isUnaryFilter(param.func)) {
              param.value = defaultParamValue(param.type);
            }
          }
          renderNodes();
          refreshQuery();
        });
        removeBtn.addEventListener("click", () => {
          node.params = node.params.filter((p) => p.id !== param.id);
          renderNodes();
          refreshQuery();
        });
      });

      el.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener("change", () => {
          const path = decodePath(input.dataset.path);
          const kind = input.dataset.kind;
          const current = getNode(node.id);
          if (!current) return;

          if (input.checked) {
            if (kind === "object") {
              // Expand the edge with no nested fields pre-selected.
              current.selection = setAtPath(current.selection, path, {});
            } else {
              current.selection = setAtPath(current.selection, path, null);
            }
          } else {
            current.selection = setAtPath(current.selection, path, undefined);
            const pathStr = pathKey(path);
            // Drop aliases for the removed field and anything under it.
            Object.keys(current.aliases || {}).forEach((key) => {
              if (key === pathStr || key.startsWith(`${pathStr}.`)) {
                delete current.aliases[key];
              }
            });
            // Drop params whose filter target lived under the removed edge.
            if (kind === "object") {
              const prefix = `${pathStr}.`;
              current.params = current.params.filter(
                (p) => !p.predicate.startsWith(prefix)
              );
            }
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

      const savedScroll = fieldScroll.get(node.id);
      if (savedScroll) {
        const fields = el.querySelector(".entity-fields");
        if (fields) {
          fields.scrollTop = savedScroll.top;
          fields.scrollLeft = savedScroll.left;
        }
      }
    });

    updateEmptyState();
  }

  function placeEntity(typeName, x, y) {
    if (!schema[typeName]) return;

    nodes.push({
      id: uid(),
      type: typeName,
      name: defaultName(typeName),
      x: Math.max(8, x),
      y: Math.max(8, y),
      selection: defaultSelection(typeName),
      params: [],
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

  function renderSelection(typeName, selection, depth, edgeFilters, pathPrefix, aliases) {
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

      const conditions = edgeFilters.get(fieldPath);
      const filterStr =
        conditions && conditions.length ? ` @filter(${conditions.join(" AND ")})` : "";

      const nestedSel = selection[field.name];
      const nestedType = field.ofType;

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
        edgeFilters,
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

  /**
   * Group filter conditions by the edge they apply to.
   * Key "" is the root function; "posts" or "posts.comments" are nested edges.
   */
  function collectConditions(node) {
    const byPath = new Map();
    (node.params || [])
      .filter((p) => p.func && p.predicate)
      .forEach((p) => {
        const walk = splitPredicatePath(node.type, p.predicate) || {
          edgeParts: [],
          leaf: p.predicate,
          edgePath: "",
        };
        const leaf = walk.leaf;
        const edgePath = walk.edgePath;
        let condition;
        if (isUnaryFilter(p.func)) {
          condition = `${p.func}(${leaf})`;
        } else {
          const valuePart =
            p.mode === "literal"
              ? formatDqlLiteral(p)
              : `$${sanitizeName(p.name, "param")}`;
          condition = `${p.func}(${leaf}, ${valuePart})`;
        }
        if (!byPath.has(edgePath)) byPath.set(edgePath, []);
        byPath.get(edgePath).push(condition);
      });
    return byPath;
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
      if (param.mode === "literal") return;
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
        const byPath = collectConditions(node);
        const rootConditions = byPath.get("") || [];
        const filter = rootConditions.length
          ? ` @filter(${rootConditions.join(" AND ")})`
          : "";
        const directives =
          (node.directives?.cascade ? " @cascade" : "") +
          (node.directives?.normalize ? " @normalize" : "");
        const body = renderSelection(
          node.type,
          node.selection,
          2,
          byPath,
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
    if (!moveState) return;
    const node = getNode(moveState.id);
    const el = canvasEl.querySelector(`.entity-node[data-id="${moveState.id}"]`);
    if (!node || !el) return;

    const canvasRect = canvasEl.getBoundingClientRect();
    node.x = Math.max(
      8,
      e.clientX - canvasRect.left - moveState.offsetX + canvasEl.scrollLeft
    );
    node.y = Math.max(
      8,
      e.clientY - canvasRect.top - moveState.offsetY + canvasEl.scrollTop
    );
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
  });

  window.addEventListener("pointerup", () => {
    if (!moveState) return;
    const el = canvasEl.querySelector(`.entity-node[data-id="${moveState.id}"]`);
    if (el) el.classList.remove("dragging");
    document.body.classList.remove("is-dragging-node");
    moveState = null;
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
    const typeName = dragPaletteType || e.dataTransfer.getData("text/plain");
    if (!typeName || !schema[typeName]) return;

    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasEl.scrollLeft - 140;
    const y = e.clientY - rect.top + canvasEl.scrollTop - 20;
    placeEntity(typeName, x, y);
  });

  clearBtn.addEventListener("click", () => {
    nodes = [];
    selectedNodeId = null;
    clearDqlDirty();
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
    nodes = [];
    selectedNodeId = null;
    animatedNodes.clear();

    drafts.forEach((draft, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      nodes.push({
        id: uid(),
        type: draft.type,
        name: draft.name,
        x: 200 + col * 40 + row * 12,
        y: 36 + row * 48 + col * 10,
        selection: draft.selection,
        params: (draft.params || []).map((p) => ({
          id: paramUid(),
          name: p.name,
          type: p.type,
          value: p.value,
          func: p.func || "",
          predicate: p.predicate || "",
          mode: p.mode || "var",
        })),
        directives: {
          cascade: !!draft.directives?.cascade,
          normalize: !!draft.directives?.normalize,
        },
        aliases: { ...(draft.aliases || {}) },
        resultName: draft.resultName || "",
      });
    });

    if (nodes.length) selectedNodeId = nodes[0].id;

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
      const msg = importQueryText(text, { source: "paste" });
      canvasEmptyEl.textContent = msg;
      setTimeout(() => updateEmptyState(), 1600);
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
  function setSchema(next) {
    schema = next;
    nodes = [];
    selectedNodeId = null;
    animatedNodes.clear();
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
    setSchema(next);
    setSchemaStatus(`Loaded ${count} entit${count === 1 ? "y" : "ies"} from ${sourceLabel}.`, "ok");
    consoleInfo(`Loaded ${count} entit${count === 1 ? "y" : "ies"} from ${sourceLabel}`, "schema");
  }

  function openSchemaModal() {
    schemaModal.hidden = false;
    setSchemaStatus("", "");
    schemaUrlInput.focus();
  }

  function closeSchemaModal() {
    schemaModal.hidden = true;
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
    setSchema(window.DQL_SCHEMA);
    setSchemaStatus("Restored the built-in sample schema.", "ok");
    consoleInfo("Restored the built-in sample schema", "schema");
  });

  /* ---------- Init ---------- */

  renderDock();
  updateEmptyState();
  initEditors();
  refreshQuery();
})();
