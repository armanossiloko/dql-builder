/**
 * Parse DQL query text into canvas-ready blocks.
 * Supports the subset the builder emits (and common hand-written variants):
 *   query Name($p: string = "x") {
 *     Result(func: type("Type")) @filter(...) @cascade @normalize {
 *       alias: predicate
 *       edge @filter(...) { ... }
 *     }
 *   }
 */
window.DQLQueryParser = (() => {
  const PARAM_TYPES = ["string", "int", "float", "bool"];

  /** Strip block, line (//), and hash (#) comments without touching string literals. */
  function stripComments(src) {
    const input = String(src || "");
    let out = "";
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      const next = input[i + 1];

      if (ch === '"' || ch === "'") {
        const q = ch;
        out += ch;
        i += 1;
        while (i < input.length && input[i] !== q) {
          if (input[i] === "\\") {
            out += input[i];
            i += 1;
            if (i < input.length) out += input[i];
            i += 1;
            continue;
          }
          out += input[i];
          i += 1;
        }
        if (i < input.length) out += input[i];
        continue;
      }

      if (ch === "/" && next === "*") {
        i += 2;
        while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
        i += 1; // land on '/'
        out += " ";
        continue;
      }

      if ((ch === "/" && next === "/") || ch === "#") {
        while (i < input.length && input[i] !== "\n") i += 1;
        i -= 1;
        out += " ";
        continue;
      }

      out += ch;
    }
    return out;
  }

  function skipWs(src, i) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    return i;
  }

  function extractBalanced(src, openIdx, openCh = "{", closeCh = "}") {
    if (src[openIdx] !== openCh) throw new Error(`Expected '${openCh}'`);
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
        continue;
      }
      if (ch === openCh) depth += 1;
      else if (ch === closeCh) {
        depth -= 1;
        if (depth === 0) return { inner: src.slice(openIdx + 1, i), end: i + 1 };
      }
    }
    throw new Error(`Unbalanced '${openCh}${closeCh}'`);
  }

  function readIdent(src, i) {
    i = skipWs(src, i);
    const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!m) return null;
    return { value: m[0], end: i + m[0].length };
  }

  /** Dotted predicate: User.email / Post.title */
  function readPredicate(src, i) {
    i = skipWs(src, i);
    const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/);
    if (!m) return null;
    return { value: m[0], end: i + m[0].length };
  }

  function parseStringLiteral(raw) {
    const t = String(raw || "").trim();
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))
    ) {
      try {
        // Prefer JSON for double-quoted; fall back for single-quoted.
        if (t[0] === '"') return JSON.parse(t);
        return t.slice(1, -1).replace(/\\'/g, "'");
      } catch {
        return t.slice(1, -1);
      }
    }
    return t;
  }

  function inferTypeFromLiteral(raw) {
    const t = String(raw ?? "").trim();
    if (/^(true|false)$/i.test(t)) return "bool";
    if (/^-?\d+$/.test(t)) return "int";
    if (/^-?\d+\.\d+$/.test(t)) return "float";
    return "string";
  }

  /** Parse `$name: type` / `$name: type = <literal>` with string-aware defaults. */
  function parseSignature(sig) {
    if (!sig) return [];
    const params = [];
    let i = 0;
    const src = String(sig).replace(/^\(/, "").replace(/\)$/, "");

    while (i < src.length) {
      i = skipWs(src, i);
      if (i >= src.length) break;
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      if (src[i] !== "$") break;
      i += 1;
      const name = readIdent(src, i);
      if (!name) break;
      i = name.end;
      i = skipWs(src, i);
      if (src[i] !== ":") break;
      i += 1;
      const typeTok = readIdent(src, i);
      if (!typeTok) break;
      i = typeTok.end;
      i = skipWs(src, i);

      let mode = "var";
      let value = "";
      if (src[i] === "=") {
        i += 1;
        i = skipWs(src, i);
        const start = i;
        if (src[i] === '"' || src[i] === "'") {
          const q = src[i];
          i += 1;
          while (i < src.length && src[i] !== q) {
            if (src[i] === "\\") i += 1;
            i += 1;
          }
          if (i < src.length) i += 1;
          mode = "default";
          value = String(parseStringLiteral(src.slice(start, i)));
        } else {
          while (i < src.length && src[i] !== ",") i += 1;
          mode = "default";
          value = String(parseStringLiteral(src.slice(start, i).trim()));
        }
      }

      params.push({
        name: name.value,
        type: PARAM_TYPES.includes(typeTok.value) ? typeTok.value : "string",
        mode,
        value,
      });
    }
    return params;
  }

  /** Split filter body on top-level AND / OR. */
  function splitFilterConnectors(filterInner) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let sawOr = false;
    const s = String(filterInner || "");
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < s.length && s[i] !== q) {
          if (s[i] === "\\") i += 1;
          i += 1;
        }
      } else if (depth === 0) {
        const andMatch = s.slice(i).match(/^\s+AND\s+/i);
        const orMatch = s.slice(i).match(/^\s+OR\s+/i);
        const match = andMatch || orMatch;
        if (match) {
          if (orMatch) sawOr = true;
          parts.push(s.slice(start, i).trim());
          i += match[0].length - 1;
          start = i + 1;
        }
      }
    }
    parts.push(s.slice(start).trim());
    return { parts: parts.filter(Boolean), sawOr };
  }

  /**
   * Parse one filter condition: `eq(pred, val)`, `has(pred)`, `not eq(...)`.
   * Returns { func, predicate, valueRaw, isVar, varName, literal, unary } | null
   */
  function parseOneFilterCondition(part) {
    const s = String(part || "").trim();
    if (!s) return null;

    const notMatch = s.match(/^(not)\s+/i);
    let rest = s;
    let notPrefix = "";
    if (notMatch) {
      notPrefix = "not ";
      rest = s.slice(notMatch[0].length).trim();
    }

    const nameMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!nameMatch) return null;
    const funcName = nameMatch[1];
    const openIdx = rest.indexOf("(");
    let bal;
    try {
      bal = extractBalanced(rest, openIdx, "(", ")");
    } catch {
      return null;
    }
    // Reject trailing junk after the closing paren.
    if (rest.slice(bal.end).trim()) return null;

    const argsInner = bal.inner.trim();
    if (!argsInner) return null;

    // Split args on top-level comma.
    const args = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < argsInner.length; i += 1) {
      const ch = argsInner[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < argsInner.length && argsInner[i] !== q) {
          if (argsInner[i] === "\\") i += 1;
          i += 1;
        }
      } else if (ch === "," && depth === 0) {
        args.push(argsInner.slice(start, i).trim());
        start = i + 1;
      }
    }
    args.push(argsInner.slice(start).trim());

    const predicate = args[0];
    if (!predicate || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(predicate)) return null;

    const unary = args.length === 1;
    const valueRaw = unary ? "" : args.slice(1).join(", ").trim();
    const isVar = !unary && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(valueRaw);

    return {
      func: `${notPrefix}${funcName}`,
      predicate,
      valueRaw,
      isVar,
      varName: isVar ? valueRaw.slice(1) : null,
      literal: unary || isVar ? null : String(parseStringLiteral(valueRaw)),
      unary,
    };
  }

  /**
   * Split `@filter(...)` conditions on top-level AND/OR.
   * Returns [{ func, predicate, valueRaw, isVar, varName, literal, unary }]
   */
  function parseFilterArgs(filterInner) {
    const { parts, sawOr } = splitFilterConnectors(filterInner);
    const filters = parts.map(parseOneFilterCondition).filter(Boolean);
    if (sawOr && filters.length) {
      filters[0].sawOr = true;
    }
    return filters;
  }

  function parseDirectivesAndFilter(src, i) {
    const result = {
      cascade: false,
      normalize: false,
      filters: [],
      end: i,
    };
    while (true) {
      i = skipWs(src, i);
      if (src[i] !== "@") break;
      const name = readIdent(src, i + 1);
      if (!name) break;
      i = name.end;
      if (name.value === "cascade") result.cascade = true;
      else if (name.value === "normalize") result.normalize = true;
      else if (name.value === "filter") {
        i = skipWs(src, i);
        const bal = extractBalanced(src, i, "(", ")");
        result.filters.push(...parseFilterArgs(bal.inner));
        i = bal.end;
      } else {
        // Unknown directive with optional (...): skip args.
        i = skipWs(src, i);
        if (src[i] === "(") i = extractBalanced(src, i, "(", ")").end;
      }
    }
    result.end = i;
    return result;
  }

  function parseSelection(body) {
    const fields = [];
    let i = 0;
    const src = String(body || "");
    while (i < src.length) {
      i = skipWs(src, i);
      if (i >= src.length) break;

      let alias = null;
      let pred = readPredicate(src, i);
      if (!pred) {
        // Skip unknown tokens to avoid infinite loops.
        i += 1;
        continue;
      }
      i = pred.end;
      i = skipWs(src, i);

      if (src[i] === ":") {
        alias = pred.value;
        i += 1;
        pred = readPredicate(src, i);
        if (!pred) throw new Error(`Expected predicate after alias '${alias}:'`);
        i = pred.end;
      }

      const dirs = parseDirectivesAndFilter(src, i);
      i = dirs.end;
      i = skipWs(src, i);

      let children = null;
      if (src[i] === "{") {
        const bal = extractBalanced(src, i);
        children = parseSelection(bal.inner);
        i = bal.end;
      }

      fields.push({
        alias: alias || null,
        name: pred.value,
        filters: dirs.filters,
        cascade: dirs.cascade,
        normalize: dirs.normalize,
        children,
      });
    }
    return fields;
  }

  function parseRootBlock(body) {
    let i = skipWs(body, 0);
    const resultName = readIdent(body, i);
    if (!resultName) throw new Error("Expected result key after query '{'");
    i = resultName.end;
    i = skipWs(body, i);
    if (body[i] !== "(") throw new Error("Expected (func: type(...)) on root block");

    const argsBal = extractBalanced(body, i, "(", ")");
    const args = argsBal.inner;
    i = argsBal.end;

    const typeMatch =
      args.match(/func\s*:\s*type\s*\(\s*"([^"]+)"\s*\)/i) ||
      args.match(/func\s*:\s*type\s*\(\s*'([^']+)'\s*\)/i) ||
      args.match(/func\s*:\s*type\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/i);
    if (!typeMatch) throw new Error('Expected func: type("TypeName") on root block');
    const typeName = typeMatch[1];

    const dirs = parseDirectivesAndFilter(body, i);
    i = dirs.end;
    i = skipWs(body, i);
    if (body[i] !== "{") throw new Error("Expected selection '{' on root block");
    const sel = extractBalanced(body, i);

    return {
      resultName: resultName.value,
      typeName,
      cascade: dirs.cascade,
      normalize: dirs.normalize,
      filters: dirs.filters,
      selection: parseSelection(sel.inner),
    };
  }

  function parse(text) {
    const src = stripComments(text).trim();
    if (!src) throw new Error("Nothing to parse");
    if (!/\bquery\b/i.test(src)) {
      throw new Error("Expected one or more `query Name { ... }` operations");
    }

    const operations = [];
    const re = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\((?:[^()"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*\))?\s*\{/gi;
    let m;
    while ((m = re.exec(src))) {
      const opName = m[1];
      const signature = m[2] || "";
      const openIdx = m.index + m[0].length - 1;
      const bal = extractBalanced(src, openIdx);
      const root = parseRootBlock(bal.inner);
      operations.push({
        opName,
        params: parseSignature(signature),
        ...root,
      });
      re.lastIndex = bal.end;
    }

    if (!operations.length) {
      throw new Error("Could not find a parseable query operation");
    }
    return operations;
  }

  /** Guess a nested type name from an edge when the schema has no binding. */
  function guessNestedType(edgeName, parentType, schema) {
    let base = edgeName;
    if (/ies$/i.test(base)) base = `${base.slice(0, -3)}y`;
    else if (/ses$/i.test(base)) base = base.slice(0, -2);
    else if (/s$/i.test(base) && !/ss$/i.test(base)) base = base.slice(0, -1);
    base = base.charAt(0).toUpperCase() + base.slice(1);
    if (schema[base] && base !== parentType) return base;
    if (base === parentType) return `${parentType}_${edgeName}`;
    // Prefer an unused name; if taken by something unrelated, namespace.
    if (!schema[base]) return base;
    return `${parentType}_${edgeName}`;
  }

  function findField(typeDef, predName) {
    if (!typeDef) return null;
    const exact = typeDef.fields.find((f) => f.name === predName);
    if (exact) return exact;
    const leaf = predName.includes(".") ? predName.split(".").pop() : predName;
    return typeDef.fields.find((f) => f.name === leaf) || null;
  }

  /**
   * Ensure schema contains every type/field referenced by the parsed ops.
   * Mutates a shallow copy of schema; returns { schema, warnings }.
   */
  function ensureSchema(schema, operations) {
    const next = { ...schema };
    Object.keys(schema).forEach((k) => {
      next[k] = { ...schema[k], fields: [...(schema[k].fields || [])] };
    });
    const warnings = [];
    const COLORS = [
      "#1f8a5a", "#d97706", "#2563eb", "#0f766e", "#b91c1c", "#7c3aed",
      "#be185d", "#4d7c0f", "#0e7490", "#a16207",
    ];

    function ensureType(name) {
      if (!next[name]) {
        next[name] = {
          color: COLORS[Object.keys(next).length % COLORS.length],
          fields: [{ name: "uid", type: "uid", kind: "scalar" }],
        };
        warnings.push(`Inferred type "${name}" (not in schema)`);
      }
      return next[name];
    }

    function ensureField(typeName, fieldAst, pathPrefix) {
      const def = ensureType(typeName);
      const predName = fieldAst.name;
      let field = findField(def, predName);
      const storedName = field ? field.name : predName;

      if (fieldAst.children) {
        let ofType = field?.ofType;
        if (!ofType) {
          ofType = guessNestedType(predName.includes(".") ? predName.split(".").pop() : predName, typeName, next);
        }
        ensureType(ofType);
        if (!field) {
          def.fields.push({
            name: storedName,
            type: "[uid]",
            kind: "object",
            ofType,
          });
          field = def.fields[def.fields.length - 1];
        } else if (field.kind !== "object") {
          field.kind = "object";
          field.type = "[uid]";
          field.ofType = ofType;
        } else if (!field.ofType) {
          field.ofType = ofType;
        }
        ofType = field.ofType;
        const childPrefix = pathPrefix ? `${pathPrefix}.${storedName}` : storedName;
        fieldAst.children.forEach((child) => ensureField(ofType, child, childPrefix));
      } else if (!field) {
        def.fields.push({
          name: storedName,
          type: "string",
          kind: "scalar",
        });
      }

      // Rewrite AST name to the schema field name for later selection mapping.
      fieldAst.schemaName = storedName;
    }

    operations.forEach((op) => {
      ensureType(op.typeName);
      (op.selection || []).forEach((f) => ensureField(op.typeName, f, ""));

      let notedOr = false;
      const noteOr = (filters) => {
        if (!notedOr && filters?.some((f) => f.sawOr)) {
          notedOr = true;
          warnings.push(
            `OR in @filter was flattened to AND (canvas edits filters as AND only)`
          );
        }
      };
      noteOr(op.filters);
      const walkSel = (fields) => {
        (fields || []).forEach((f) => {
          noteOr(f.filters);
          if (f.children) walkSel(f.children);
        });
      };
      walkSel(op.selection);
    });

    return { schema: next, warnings };
  }

  /**
   * Convert parsed operations + schema into canvas node objects
   * (without ids / positions — caller assigns those).
   */
  function toNodes(operations, schema) {
    function resolveFieldType(rootType, predicatePath) {
      const parts = String(predicatePath || "").split(".").filter(Boolean);
      let typeName = rootType;
      for (let i = 0; i < parts.length; i += 1) {
        const field = findField(schema[typeName], parts[i]);
        if (!field) return null;
        if (i === parts.length - 1) {
          return PARAM_TYPES.includes(field.type) ? field.type : null;
        }
        if (!field.ofType) return null;
        typeName = field.ofType;
      }
      return null;
    }

    return operations.map((op) => {
      const aliases = {};
      const params = [];
      const paramByName = new Map();

      (op.params || []).forEach((p) => {
        const entry = {
          name: p.name,
          type: PARAM_TYPES.includes(p.type) ? p.type : "string",
          value: p.value ?? "",
          func: "",
          predicate: "",
          mode: p.mode || "var",
        };
        params.push(entry);
        paramByName.set(p.name, entry);
      });

      function addFilter(edgePath, filter) {
        const leaf = filter.predicate.includes(".")
          ? filter.predicate.split(".").pop()
          : filter.predicate;
        // Prefer matching a real schema field on the edge's type.
        let predicatePath = edgePath ? `${edgePath}.${leaf}` : leaf;

        // Try to resolve against schema for exact / namespaced names.
        const walk = edgePath ? edgePath.split(".") : [];
        let typeName = op.typeName;
        for (const part of walk) {
          const f = findField(schema[typeName], part);
          if (!f?.ofType) break;
          typeName = f.ofType;
        }
        const leafField = findField(schema[typeName], filter.predicate);
        if (leafField) {
          predicatePath = edgePath ? `${edgePath}.${leafField.name}` : leafField.name;
        }

        const schemaType = resolveFieldType(op.typeName, predicatePath);
        const literalType =
          filter.literal != null ? inferTypeFromLiteral(filter.valueRaw || filter.literal) : null;
        const inferredType = schemaType || literalType || "string";
        const nameSeed = (leafField?.name || leaf).replace(/\./g, "_");

        if (filter.isVar && filter.varName) {
          let entry = paramByName.get(filter.varName);
          if (!entry) {
            entry = {
              name: filter.varName,
              type: inferredType,
              value: "",
              func: filter.func,
              predicate: predicatePath,
              mode: "var",
            };
            params.push(entry);
            paramByName.set(filter.varName, entry);
          } else {
            entry.func = filter.func;
            entry.predicate = predicatePath;
            if (entry.type === "string" && inferredType !== "string") {
              entry.type = inferredType;
            }
          }
        } else if (filter.unary) {
          params.push({
            name: nameSeed,
            type: inferredType,
            value: "",
            func: filter.func,
            predicate: predicatePath,
            mode: "literal",
          });
        } else {
          params.push({
            name: nameSeed,
            type: inferredType,
            value: filter.literal ?? "",
            func: filter.func,
            predicate: predicatePath,
            mode: "literal",
          });
        }
      }

      (op.filters || []).forEach((f) => addFilter("", f));

      function buildSelection(typeName, fieldAsts, pathPrefix) {
        const selection = {};
        (fieldAsts || []).forEach((f) => {
          const name = f.schemaName || findField(schema[typeName], f.name)?.name || f.name;
          const path = pathPrefix ? `${pathPrefix}.${name}` : name;
          if (f.alias) aliases[path] = f.alias;
          (f.filters || []).forEach((flt) => addFilter(path, flt));

          if (f.children) {
            const field = findField(schema[typeName], name);
            const ofType = field?.ofType || guessNestedType(name, typeName, schema);
            selection[name] = buildSelection(ofType, f.children, path);
          } else {
            selection[name] = null;
          }
        });
        return selection;
      }

      const selection = buildSelection(op.typeName, op.selection, "");

      // Result key only stored when it differs from the default derived from op name.
      let resultName = op.resultName || "";
      const derived = /^get./i.test(op.opName) ? op.opName.slice(3) : op.opName;
      if (resultName === derived || resultName === op.typeName) {
        // Keep explicit when it matches type but would also be the default — still fine empty
        // if derived === typeName (getUser → User).
        if (resultName === derived) resultName = "";
      }

      return {
        type: op.typeName,
        name: op.opName,
        resultName,
        selection,
        aliases,
        params,
        directives: {
          cascade: !!op.cascade,
          normalize: !!op.normalize,
        },
      };
    });
  }

  return { parse, ensureSchema, toNodes };
})();
