/* The CodeMirror 6 surface for report authoring: markdown with SQL-highlighted
   ```sql fences, the console's dark-aware theme, and report-dialect autocomplete
   (component tags + `${query}`/`params.` + native SQL schema completion inside
   fences). Save (Mod-s) / Preview (Mod-Enter) are wired through refs so the
   extension set stays stable across typing. */

import { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { PostgreSQL, sql } from "@codemirror/lang-sql";

import { waddleEditorTheme } from "./editorTheme";
import { reportCompletionSource, sqlSchema } from "./completions";

/** A lang-sql support (PostgreSQL ≈ DuckDB) carrying the substrate + dataset
 *  schema, with the report `${…}` completion source layered onto its data. */
function sqlSupport(datasets: readonly string[]): LanguageSupport {
  const base = sql({ dialect: PostgreSQL, schema: sqlSchema(datasets), upperCaseKeywords: false });
  return new LanguageSupport(base.language, [
    base.support,
    base.language.data.of({ autocomplete: reportCompletionSource }),
  ]);
}

function buildExtensions(
  datasets: readonly string[],
  onSave: () => void,
  onPreview: () => void,
): Extension[] {
  const sqlDesc = LanguageDescription.of({
    name: "sql",
    alias: ["sql", "postgresql", "duckdb"],
    load: async () => sqlSupport(datasets),
  });
  return [
    markdown({ base: markdownLanguage, codeLanguages: [sqlDesc] }),
    markdownLanguage.data.of({ autocomplete: reportCompletionSource }),
    waddleEditorTheme,
    EditorView.lineWrapping,
    Prec.highest(
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (onPreview(), true) },
      ]),
    ),
  ];
}

export function ReportEditor({
  value,
  onChange,
  onSave,
  onPreview,
  datasets,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onPreview: () => void;
  datasets: readonly string[];
}) {
  // Keep the callbacks fresh without rebuilding (and remounting) the editor.
  const saveRef = useRef(onSave);
  const previewRef = useRef(onPreview);
  saveRef.current = onSave;
  previewRef.current = onPreview;

  const extensions = useMemo(
    () => buildExtensions(datasets, () => saveRef.current(), () => previewRef.current()),
    [datasets],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      height="100%"
      className="h-full text-[12.5px]"
      basicSetup={{ foldGutter: false, highlightActiveLine: true }}
    />
  );
}
