// Pure-PEG view of the grammar: peggy's own parser gives us the AST (no
// codegen, no eval); we pretty-print rules with all JS stripped. Semantic
// predicates are kept as `&{…}` / `!{…}` placeholders so their presence —
// but not their code — remains visible.

import * as peggy from "peggy";
import { VersionMemo } from "./upstream";

// Minimal structural typing for the peggy AST nodes we print.
interface AstNode {
  type: string;
  [key: string]: unknown;
}

const pureMemo = new VersionMemo<{ text: string; rules: Map<string, string> }>();

export function pureGrammar(
  sha: string,
  grammarText: string,
): { text: string; rules: Map<string, string> } {
  return pureMemo.get(sha, () => {
    const ast = peggy.parser.parse(grammarText) as unknown as {
      rules: AstNode[];
    };
    const rules = new Map<string, string>();
    for (const rule of ast.rules) {
      rules.set(
        rule.name as string,
        `${rule.name} = ${print(rule.expression as AstNode, 0)}`,
      );
    }
    return { text: [...rules.values()].join("\n\n"), rules };
  });
}

/** One rule plus the source of rules it directly references (one hop). */
export function ruleWithNeighbors(
  sha: string,
  grammarText: string,
  name: string,
  budget = 8000,
): { rule: string; referenced: string[]; included: string } | null {
  const { rules } = pureGrammar(sha, grammarText);
  const rule = rules.get(name);
  if (rule === undefined) return null;
  // Strip string literals and character classes so identifiers inside them
  // (e.g. literal "help") are not mistaken for rule references.
  const bare = rule
    .replace(/"(?:[^"\\]|\\.)*"i?/g, '""')
    .replace(/\[(?:[^\]\\]|\\.)*\]i?/g, "[]");
  const refs = [...new Set(bare.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])]
    .filter((r) => r !== name && rules.has(r));
  const parts: string[] = [];
  let used = 0;
  for (const r of refs) {
    const text = rules.get(r)!;
    if (used + text.length > budget) break;
    parts.push(text);
    used += text.length;
  }
  return { rule, referenced: refs, included: parts.join("\n\n") };
}

function print(node: AstNode, prec: number): string {
  switch (node.type) {
    case "choice": {
      const s = (node.alternatives as AstNode[])
        .map((a) => print(a, 1))
        .join(" / ");
      return prec > 0 ? `(${s})` : s;
    }
    case "sequence": {
      const s = (node.elements as AstNode[])
        .map((e) => print(e, 2))
        .join(" ");
      return prec > 1 ? `(${s})` : s;
    }
    case "action":
      // Drop the JS action; print the wrapped expression.
      return print(node.expression as AstNode, prec);
    case "labeled": {
      const inner = print(node.expression as AstNode, 3);
      if (node.pick) return inner === "" ? "" : `@${inner}`;
      return node.label ? `${node.label}:${inner}` : inner;
    }
    case "named":
      return print(node.expression as AstNode, prec);
    case "text":
      return `$${print(node.expression as AstNode, 3)}`;
    case "simple_and":
      return `&${print(node.expression as AstNode, 3)}`;
    case "simple_not":
      return `!${print(node.expression as AstNode, 3)}`;
    case "semantic_and":
      return "&{…}";
    case "semantic_not":
      return "!{…}";
    case "optional":
      return `${print(node.expression as AstNode, 3)}?`;
    case "zero_or_more":
      return `${print(node.expression as AstNode, 3)}*`;
    case "one_or_more":
      return `${print(node.expression as AstNode, 3)}+`;
    case "repeated": {
      const min = node.min != null ? printBoundary(node.min as AstNode) : "";
      const max = node.max != null ? printBoundary(node.max as AstNode) : "";
      const delim = node.delimiter
        ? `, ${print(node.delimiter as AstNode, 0)}`
        : "";
      return `${print(node.expression as AstNode, 3)}|${min}..${max}${delim}|`;
    }
    case "group":
      return `(${print(node.expression as AstNode, 0)})`;
    case "rule_ref":
      return node.name as string;
    case "library_ref":
      return `${node.library as string}.${node.name as string}`;
    case "literal":
      return (
        JSON.stringify(node.value as string) + (node.ignoreCase ? "i" : "")
      );
    case "class": {
      const parts = (node.parts as (string | string[])[])
        .map((p) =>
          Array.isArray(p)
            ? `${escapeClass(p[0])}-${escapeClass(p[1])}`
            : escapeClass(p),
        )
        .join("");
      return `[${node.inverted ? "^" : ""}${parts}]${node.ignoreCase ? "i" : ""}`;
    }
    case "any":
      return ".";
    default:
      return `<${node.type}>`;
  }
}

function printBoundary(node: AstNode): string {
  if (node.type === "constant" || node.type === "variable")
    return node.value == null ? "" : String(node.value);
  return "";
}

function escapeClass(ch: string): string {
  if (ch === "]" || ch === "\\" || ch === "^" || ch === "-") return `\\${ch}`;
  const code = ch.charCodeAt(0);
  if (code < 0x20)
    return `\\x${code.toString(16).padStart(2, "0")}`;
  return ch;
}
