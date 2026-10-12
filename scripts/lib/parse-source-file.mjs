import ts from "typescript";

/*
FNXC:ScriptAstGates 2026-10-12-04:37:
A script AST gate never reports a result for a file it did not fully parse.
`ts.createSourceFile` does not throw on bad syntax: it returns a partial tree plus `parseDiagnostics`.
Under `ScriptKind.TSX` a `.ts` generic arrow (`<T>(run: () => Promise<T>) => ...`) or an angle-bracket assertion (`<number>value`) opens a phantom JSX element, and every later construct is absent from the tree while the gate still counts the file as inspected.
So the parse mode follows the file extension, and any parse diagnostic fails closed instead of yielding a partial result.
Gates parse through this module so the rule has one implementation.
*/

/** The parse mode a file's extension implies. Anything that is not JavaScript or JSX-bearing is TypeScript. */
export function scriptKindForFile(file) {
  const name = file.toLowerCase();
  if (name.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (name.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * A scanned file that did not parse cleanly. Thrown instead of returning a tree because a partial
 * tree silently omits every construct after the first syntax error.
 */
export class SourceParseError extends Error {
  constructor(file, diagnosticCount, line, detail) {
    super(
      `${file}:${line}: ${diagnosticCount} parse error(s), first: "${detail}". `
        + "The file was not inspected, so no result can be reported for it.",
    );
    this.name = "SourceParseError";
    this.file = file;
    this.diagnosticCount = diagnosticCount;
    this.line = line;
    this.detail = detail;
  }
}

/**
 * Parse `source` in the mode `file`'s extension implies.
 * @throws {SourceParseError} when the parser reports any diagnostic.
 */
export function parseSourceFileStrict(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindForFile(file));
  const parseErrors = sourceFile.parseDiagnostics ?? [];
  if (parseErrors.length > 0) {
    const first = parseErrors[0];
    throw new SourceParseError(
      file,
      parseErrors.length,
      sourceFile.getLineAndCharacterOfPosition(first.start ?? 0).line + 1,
      ts.flattenDiagnosticMessageText(first.messageText, " "),
    );
  }
  return sourceFile;
}

/**
 * Run a gate entry point. A `SourceParseError` ends the process with exit code 1 and a readable
 * message; every other error propagates unchanged.
 */
export function failClosedOnParseError(label, run) {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof SourceParseError)) throw error;
    console.error(`[${label}] ${error.message}`);
    console.error("Refusing to report or record any result until the file parses.");
    process.exit(1);
  }
}
