/* The CodeMirror 6 theme for the report editor — one file: editor chrome plus a
   syntax HighlightStyle. Chrome colors reference the console's CSS variables
   (`hsl(var(--…))`) so the editor tracks the app's light/dark toggle for free.
   The token colors are fixed mid-tone hues chosen to read on both the light and
   the dark card background (the console is dark-first but supports both). */

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const chrome = EditorView.theme({
  "&": {
    color: "hsl(var(--foreground))",
    backgroundColor: "hsl(var(--card))",
    fontSize: "12.5px",
    height: "100%",
  },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { caretColor: "hsl(var(--primary))" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--primary))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "hsl(var(--primary) / 0.22)",
  },
  ".cm-gutters": {
    backgroundColor: "hsl(var(--card))",
    color: "hsl(var(--muted-foreground))",
    border: "none",
    borderRight: "1px solid hsl(var(--border))",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "hsl(var(--muted) / 0.5)",
    color: "hsl(var(--foreground))",
  },
  ".cm-activeLine": { backgroundColor: "hsl(var(--muted) / 0.35)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 8px" },
  ".cm-selectionMatch": { backgroundColor: "hsl(var(--primary) / 0.15)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "hsl(var(--primary) / 0.2)",
    outline: "1px solid hsl(var(--primary) / 0.4)",
  },
  ".cm-tooltip": {
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "8px",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.28)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: MONO,
    fontSize: "12px",
    maxHeight: "16rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "hsl(var(--primary) / 0.18)",
    color: "hsl(var(--foreground))",
  },
  ".cm-completionLabel": { color: "hsl(var(--foreground))" },
  ".cm-completionMatchedText": { color: "hsl(var(--primary))", textDecoration: "none" },
  ".cm-completionDetail": {
    color: "hsl(var(--muted-foreground))",
    fontStyle: "normal",
    marginLeft: "1rem",
  },
  ".cm-completionIcon": { color: "hsl(var(--muted-foreground))", opacity: "0.8" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#d1620a", fontWeight: "500" },
  { tag: [t.string, t.special(t.string), t.monospace], color: "#4c9a4c" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#3b82c4" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8a8580", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#b07dd6" },
  { tag: [t.typeName, t.className], color: "#3b9ea3" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "#3b82c4" },
  { tag: [t.operator, t.punctuation, t.separator], color: "hsl(var(--muted-foreground))" },
  { tag: [t.heading], color: "#c2410c", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600", color: "hsl(var(--foreground))" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "#3b82c4", textDecoration: "underline" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "#8a8580" },
]);

/** The complete editor theme: chrome + syntax highlighting. */
export const waddleEditorTheme: Extension = [chrome, syntaxHighlighting(highlight)];
