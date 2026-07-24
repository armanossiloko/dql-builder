/**
 * Converts a GraphQL schema (introspection JSON or SDL text) into the
 * builder's entity format:
 *   { TypeName: { color, fields: [{ name, type, kind, ofType? }] } }
 */
window.DQLSchemaLoader = (() => {
  const COLORS = [
    "#1f8a5a", "#d97706", "#2563eb", "#0f766e", "#b91c1c", "#7c3aed",
    "#be185d", "#4d7c0f", "#0e7490", "#a16207", "#6d28d9", "#374151",
  ];

  const SCALAR_MAP = {
    ID: "uid",
    String: "string",
    Int: "int",
    Long: "int",
    Short: "int",
    Byte: "int",
    Float: "float",
    Decimal: "float",
    Boolean: "bool",
    DateTime: "datetime",
    Date: "datetime",
    LocalDate: "datetime",
    LocalDateTime: "datetime",
  };

  const INTROSPECTION_QUERY = `
    query BuilderIntrospection {
      __schema {
        queryType { name }
        mutationType { name }
        subscriptionType { name }
        types {
          kind
          name
          fields {
            name
            type {
              kind name
              ofType { kind name
                ofType { kind name
                  ofType { kind name
                    ofType { kind name
                      ofType { kind name
                        ofType { kind name } } } } } }
            }
          }
        }
      }
    }
  `;

  function mapScalar(graphqlName) {
    return SCALAR_MAP[graphqlName] || "string";
  }

  /** Remove edges pointing at dropped types, then drop empty types (fixpoint). */
  function prune(out) {
    let changed = true;
    while (changed) {
      changed = false;
      Object.entries(out).forEach(([name, def]) => {
        const kept = def.fields.filter((f) => f.kind !== "object" || out[f.ofType]);
        if (kept.length !== def.fields.length) {
          def.fields = kept;
          changed = true;
        }
        if (!def.fields.length) {
          delete out[name];
          changed = true;
        }
      });
    }
    return out;
  }

  function assignColors(out) {
    Object.values(out).forEach((def, i) => {
      def.color = COLORS[i % COLORS.length];
    });
    return out;
  }

  /* ---------- Introspection JSON ---------- */

  function unwrapTypeRef(typeRef) {
    let t = typeRef;
    let isList = false;
    while (t && (t.kind === "NON_NULL" || t.kind === "LIST")) {
      if (t.kind === "LIST") isList = true;
      t = t.ofType;
    }
    return { kind: t?.kind, name: t?.name, isList };
  }

  function fromIntrospection(payload) {
    const s = payload?.data?.__schema || payload?.__schema || payload;
    if (!s || !Array.isArray(s.types)) {
      throw new Error("Not an introspection result (missing __schema.types)");
    }

    const roots = new Set(
      [s.queryType?.name, s.mutationType?.name, s.subscriptionType?.name].filter(Boolean)
    );
    const entityTypes = s.types.filter(
      (t) =>
        (t.kind === "OBJECT" || t.kind === "INTERFACE") &&
        !t.name.startsWith("__") &&
        !roots.has(t.name)
    );
    const entityNames = new Set(entityTypes.map((t) => t.name));

    const out = {};
    entityTypes.forEach((t) => {
      const fields = (t.fields || [])
        .map((f) => {
          const ref = unwrapTypeRef(f.type);
          const isComposite =
            ref.kind === "OBJECT" || ref.kind === "INTERFACE" || ref.kind === "UNION";
          if (isComposite) {
            if (!entityNames.has(ref.name)) return null;
            return {
              name: f.name,
              type: ref.isList ? "[uid]" : "uid",
              kind: "object",
              ofType: ref.name,
            };
          }
          // SCALAR / ENUM
          return { name: f.name, type: mapScalar(ref.name), kind: "scalar" };
        })
        .filter(Boolean);
      if (fields.length) out[t.name] = { color: "", fields };
    });

    return assignColors(prune(out));
  }

  /* ---------- SDL text ---------- */

  function fromSdl(sdlText) {
    let text = String(sdlText)
      .replace(/"""[\s\S]*?"""/g, " ")
      .replace(/#[^\n]*/g, " ");

    // Custom root operation types declared via `schema { query: MyQuery ... }`.
    const roots = new Set(["Query", "Mutation", "Subscription"]);
    const schemaBlock = text.match(/\bschema\b[^{]*\{([^}]*)\}/);
    if (schemaBlock) {
      [...schemaBlock[1].matchAll(/\b(?:query|mutation|subscription)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/g)]
        .forEach((m) => roots.add(m[1]));
    }

    const blockRe = /\b(type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{([^}]*)\}/g;
    const blocks = [...text.matchAll(blockRe)].filter((m) => !roots.has(m[2]));
    const entityNames = new Set(blocks.map((m) => m[2]));
    if (!blocks.length) {
      throw new Error("No type/interface definitions found in SDL");
    }

    const out = {};
    blocks.forEach(([, , typeName, body]) => {
      // Strip field argument lists and directives so only `name: TypeRef` remains.
      const cleaned = body
        .replace(/\((?:[^()"]|"(?:\\.|[^"\\])*")*\)/g, "")
        .replace(/@[A-Za-z_][A-Za-z0-9_]*/g, "");

      const fields = [...cleaned.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\[{0,3}[A-Za-z_][A-Za-z0-9_]*[!\]]{0,6})/g)]
        .map(([, fieldName, rawRef]) => {
          const isList = rawRef.includes("[");
          const refName = rawRef.replace(/[[\]!\s]/g, "");
          if (!refName) return null;
          if (entityNames.has(refName)) {
            return {
              name: fieldName,
              type: isList ? "[uid]" : "uid",
              kind: "object",
              ofType: refName,
            };
          }
          return { name: fieldName, type: mapScalar(refName), kind: "scalar" };
        })
        .filter(Boolean);
      if (fields.length) out[typeName] = { color: "", fields };
    });

    return assignColors(prune(out));
  }

  /* ---------- Pasted text (either format) ---------- */

  function fromText(raw) {
    const text = String(raw || "").replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error("Nothing to parse");
    if (text.startsWith("{")) {
      try {
        return fromIntrospection(JSON.parse(text));
      } catch (err) {
        throw new Error(`Invalid introspection JSON: ${err.message}`);
      }
    }
    return fromSdl(text);
  }

  /* ---------- Live endpoint ---------- */

  async function fetchSchema(url) {
    const errors = [];

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.data?.__schema) return fromIntrospection(json);
        errors.push("endpoint answered without __schema (introspection disabled?)");
      } else {
        errors.push(`introspection POST returned HTTP ${res.status}`);
      }
    } catch (err) {
      errors.push(`introspection POST failed: ${err.message}`);
    }

    // Some GraphQL servers expose SDL at <endpoint>?sdl.
    try {
      const sdlUrl = url.includes("?") ? `${url}&sdl` : `${url}?sdl`;
      const res = await fetch(sdlUrl);
      if (res.ok) return fromSdl(await res.text());
      errors.push(`GET ?sdl returned HTTP ${res.status}`);
    } catch (err) {
      errors.push(`GET ?sdl failed: ${err.message}`);
    }

    throw new Error(errors.join(" · "));
  }

  return { fromIntrospection, fromSdl, fromText, fetchSchema };
})();
