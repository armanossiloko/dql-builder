/** Sample schema for the visual DQL (Dgraph) builder. */
window.DQL_SCHEMA = {
  User: {
    color: "#1f8a5a",
    fields: [
      { name: "uid", type: "uid", kind: "scalar" },
      { name: "name", type: "string", kind: "scalar" },
      { name: "email", type: "string", kind: "scalar" },
      { name: "age", type: "int", kind: "scalar" },
      { name: "posts", type: "[uid]", kind: "object", ofType: "Post" },
    ],
  },
  Post: {
    color: "#d97706",
    fields: [
      { name: "uid", type: "uid", kind: "scalar" },
      { name: "title", type: "string", kind: "scalar" },
      { name: "body", type: "string", kind: "scalar" },
      { name: "published", type: "bool", kind: "scalar" },
      { name: "author", type: "uid", kind: "object", ofType: "User" },
      { name: "comments", type: "[uid]", kind: "object", ofType: "Comment" },
    ],
  },
  Comment: {
    color: "#2563eb",
    fields: [
      { name: "uid", type: "uid", kind: "scalar" },
      { name: "text", type: "string", kind: "scalar" },
      { name: "createdAt", type: "datetime", kind: "scalar" },
      { name: "author", type: "uid", kind: "object", ofType: "User" },
    ],
  },
  Product: {
    color: "#0f766e",
    fields: [
      { name: "uid", type: "uid", kind: "scalar" },
      { name: "name", type: "string", kind: "scalar" },
      { name: "price", type: "float", kind: "scalar" },
      { name: "inStock", type: "bool", kind: "scalar" },
      { name: "category", type: "string", kind: "scalar" },
    ],
  },
};
