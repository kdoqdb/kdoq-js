import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const snapshot = resolve(root, "testdata/api.txt");

function kind(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const f = target.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Variable) return "const";
  if (f & ts.SymbolFlags.Enum) return "enum";
  return "other";
}

function surface(): string {
  const entries = { "@kdoq/kdoq": "src/index.ts", "@kdoq/kdoq/value": "src/value/index.ts" };
  const program = ts.createProgram(
    Object.values(entries).map((p) => resolve(root, p)),
    {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts", "lib.esnext.disposable.d.ts", "lib.dom.d.ts"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  const lines: string[] = [];
  for (const [name, path] of Object.entries(entries)) {
    const file = program.getSourceFile(resolve(root, path))!;
    const module = checker.getSymbolAtLocation(file)!;
    lines.push(`package ${name}`);
    const exported = checker
      .getExportsOfModule(module)
      .map((s) => `${kind(s, checker)} ${s.name}`)
      .sort();
    lines.push(...exported.map((e) => `  ${e}`), "");
  }
  return lines.join("\n");
}

test("the public surface matches testdata/api.txt", () => {
  const actual = surface();
  if (process.env.UPDATE_API || !existsSync(snapshot)) writeFileSync(snapshot, actual);
  expect(actual).toBe(readFileSync(snapshot, "utf8"));
});
