#!/usr/bin/env node
// `dist/cache.worker.js` is the one file a consumer's bundler copies out of this
// package on its own, following the `new URL("./cache.worker.js",
// import.meta.url)` reference in the client half. Whatever it is emitted
// alongside — a chunk shared with `dist/index.js`, most of all — does not travel
// with it, so a worker that imports anything 404s in the consumer's build and is
// reported there as a worker that "could not be started".
//
// Whether a module both entries import becomes a shared chunk depends on what
// tree-shaking leaves of it, which is not something a rule of thumb can settle.
// This check settles it: it reads the emitted worker and fails on any reference
// to another module.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const worker = new URL("../dist/cache.worker.js", import.meta.url);
const workerPath = fileURLToPath(worker);

let source;
try {
  source = readFileSync(worker, "utf8");
} catch (error) {
  if (error.code === "ENOENT") {
    console.error(`${workerPath} does not exist. Run \`npm run build\` first.`);
    process.exit(1);
  }
  throw error;
}

/**
 * Overwrite comments and the insides of string, template and regular-expression
 * literals with spaces, so that only code is left to search. Newlines are kept,
 * so line numbers still line up with the file, and the literal delimiters are
 * kept, so an empty specifier is still recognisable as one.
 *
 * The alternative — matching against the raw text — reports this file's own
 * prose: the worker's comments discuss the imports it deliberately does not
 * make.
 */
function blankNonCode(source) {
  const out = [...source];
  const end = source.length;

  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  // A `/` opens a regular expression unless what precedes it could end an
  // expression, in which case it is division. Word characters end an expression
  // only when they spell an identifier or a number; the keywords below are
  // followed by an operand, so a `/` after one of them opens a literal.
  const OPERAND_EXPECTED = new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]);
  const endsExpression = (token) =>
    /^[\w$]+$/.test(token) ? !OPERAND_EXPECTED.has(token) : /^[)\]"'`]$/.test(token);

  /** Blank a quoted string starting at its opening `quote`; returns the index past it. */
  const scanString = (start, quote) => {
    let i = start + 1;
    while (i < end) {
      const char = source[i];
      if (char === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (char === quote) return i + 1;
      blank(i, i + 1);
      i += 1;
    }
    return i;
  };

  /** Blank a regular expression starting at its opening `/`; returns the index past it. */
  const scanRegExp = (start) => {
    let i = start + 1;
    let inClass = false;
    while (i < end) {
      const char = source[i];
      if (char === "\n") return i; // Unterminated: not a literal after all.
      if (char === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        blank(start + 1, i);
        return i + 1;
      }
      i += 1;
    }
    return i;
  };

  /**
   * Blank a template literal starting at its opening backtick. Each `${...}` is
   * code, so it is handed back to `scanCode`, which returns the index past the
   * `}` that closes it.
   */
  const scanTemplate = (start) => {
    let i = start + 1;
    while (i < end) {
      const char = source[i];
      if (char === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (char === "`") return i + 1;
      if (char === "$" && source[i + 1] === "{") {
        i = scanCode(i + 2, true);
        continue;
      }
      blank(i, i + 1);
      i += 1;
    }
    return i;
  };

  /**
   * Scan code from `start`. With `untilCloseBrace`, stop just past the `}` that
   * closes the `${` this was called for, rather than at the end of the file.
   */
  function scanCode(start, untilCloseBrace) {
    let i = start;
    let depth = 0;
    let previous = "";

    while (i < end) {
      const char = source[i];
      const next = source[i + 1];

      if (char === "/" && next === "/") {
        const newline = source.indexOf("\n", i);
        const stop = newline === -1 ? end : newline;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (char === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        const stop = close === -1 ? end : close + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (char === '"' || char === "'") {
        i = scanString(i, char);
        previous = char;
        continue;
      }
      if (char === "`") {
        i = scanTemplate(i);
        previous = "`";
        continue;
      }
      if (char === "/" && !endsExpression(previous)) {
        i = scanRegExp(i);
        previous = ")"; // A literal ends an expression, like a closing paren.
        continue;
      }
      if (/[\w$]/.test(char)) {
        let word = i;
        while (word < end && /[\w$]/.test(source[word])) word += 1;
        previous = source.slice(i, word);
        i = word;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        if (untilCloseBrace && depth === 0) return i + 1;
        depth -= 1;
      }
      if (!/\s/.test(char)) previous = char;
      i += 1;
    }
    return i;
  }

  scanCode(0, false);
  return out.join("");
}

// `import.meta` is not a module reference and `import(` is reported on its own,
// so the static-import pattern excludes both.
const REFERENCES = [
  { description: "a static import", pattern: /\bimport\b(?!\s*[.(])/g },
  { description: "a dynamic import", pattern: /\bimport\s*\(/g },
  {
    description: "a re-export from another module",
    pattern: /\bexport\s+(?:\*|\{[^}]*\})[^;\n]*?\bfrom\b/g,
  },
  { description: "a require call", pattern: /\brequire\s*\(/g },
];

const code = blankNonCode(source);
const lineStarts = [0];
for (let i = 0; i < source.length; i += 1) {
  if (source[i] === "\n") lineStarts.push(i + 1);
}
const lineOf = (index) => {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low;
};

const findings = [];
for (const { description, pattern } of REFERENCES) {
  for (const match of code.matchAll(pattern)) {
    findings.push({ description, line: lineOf(match.index) });
  }
}
findings.sort((a, b) => a.line - b.line);

if (findings.length > 0) {
  const lines = source.split("\n");
  console.error(
    `${workerPath} references other modules, but it has to be self-contained: it is the only\n` +
      `file a consumer's bundler copies out of this package, so anything it imports is left\n` +
      `behind and the worker fails to load. Give the worker half its own copy of what it shares\n` +
      `with the client half instead of importing it.\n`,
  );
  for (const { description, line } of findings) {
    console.error(`  line ${line + 1}: ${description}`);
    console.error(`    ${lines[line].trim()}`);
  }
  process.exit(1);
}

console.log(`${workerPath} is self-contained (no imports).`);
