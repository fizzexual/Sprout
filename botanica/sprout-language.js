// sprout-language.js — teaches Monaco how to highlight Sprout and Bloom.
// Exposes window.registerSproutLanguages(monaco), called once Monaco is ready.

window.registerSproutLanguages = function registerSproutLanguages(monaco) {
  // ----- Sprout -----
  monaco.languages.register({ id: "sprout", extensions: [".sprout"] });
  monaco.languages.setLanguageConfiguration("sprout", {
    comments: { lineComment: "~" },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider("sprout", {
    defaultToken: "",
    keywords: [
      "make", "set", "show", "when", "orwhen", "otherwise",
      "repeat", "while", "times", "task", "give", "style",
      "and", "or", "not",
    ],
    constants: ["yes", "no", "nothing"],
    builtins: [
      "window", "server", "label", "button", "field", "textof",
      "abs", "round", "floor", "ceil", "sqrt", "min", "max",
      "length", "upper", "lower", "random",
    ],
    tokenizer: {
      root: [
        [/~.*$/, "comment"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/[a-zA-Z_]\w*/, {
          cases: {
            "@keywords": "keyword",
            "@constants": "constant",
            "@builtins": "type.identifier",
            "@default": "identifier",
          },
        }],
        [/[=<>!%+\-*/]+/, "operator"],
        [/[(),:]/, "delimiter"],
      ],
    },
  });

  // ----- Bloom (Sprout's CSS) -----
  monaco.languages.register({ id: "bloom", extensions: [".bloom"] });
  monaco.languages.setLanguageConfiguration("bloom", {
    comments: { lineComment: "~" },
  });
  monaco.languages.setMonarchTokensProvider("bloom", {
    defaultToken: "",
    tokenizer: {
      root: [
        [/~.*$/, "comment"],
        // selector lines (not indented): "button:", "#display:", "window:"
        [/^[#a-zA-Z][\w-]*\s*:/, "type"],
        // property: value
        [/^\s+[a-zA-Z-]+\s*:/, "attribute.name"],
        [/#[0-9a-fA-F]{3,8}\b/, "number.hex"],
        [/\b\d+\b/, "number"],
        [/"[^"]*"/, "string"],
      ],
    },
  });

  // ----- theme -----
  monaco.editor.defineTheme("botanica-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5c7a5e", fontStyle: "italic" },
      { token: "keyword", foreground: "7bd88f", fontStyle: "bold" },
      { token: "constant", foreground: "f2a65a" },
      { token: "type.identifier", foreground: "79b8ff" },
      { token: "type", foreground: "79b8ff", fontStyle: "bold" },
      { token: "attribute.name", foreground: "c9a8ff" },
      { token: "string", foreground: "e6d27a" },
      { token: "number", foreground: "f2a65a" },
      { token: "number.hex", foreground: "f2a65a" },
      { token: "operator", foreground: "9aa0a6" },
    ],
    colors: {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#e6efe6",
      "editorLineNumber.foreground": "#4a554b",
      "editorCursor.foreground": "#7bd88f",
      "editor.selectionBackground": "#2f4a36",
      "editor.lineHighlightBackground": "#26302700",
    },
  });
};
