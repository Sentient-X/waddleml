/* Walks the server-compiled RenderBlock tree into the console's visual language:
   markdown (values already interpolated server-side) via react-markdown, and
   component blocks via the registry. A component whose backing query failed
   renders an inline error card in its place rather than an empty widget. */

import type { ReactNode } from "react";
import { Fragment } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle } from "lucide-react";

import type { RenderBlock, SqlResult } from "@/api/types";
import { ReportComponent, type RenderContext } from "./registry";

function QueryErrorCard({ query, message }: { query: string; message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        <span className="mr-2 font-mono text-xs uppercase text-destructive">{query}</span>
        <span className="text-destructive">{message}</span>
      </div>
    </div>
  );
}

/* Tailwind "prose-like" styling kept local (no @tailwindcss/typography): compact
   headings + spacing that match the dense console, on light and dark. */
const MARKDOWN_CLASS = [
  "text-sm leading-relaxed text-foreground",
  "[&_h1]:mt-1 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-3 [&_pre]:text-xs",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs",
  "[&_th]:border-b [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border-b [&_td]:px-2 [&_td]:py-1",
].join(" ");

export function BlockRenderer({
  blocks,
  results,
  queryErrors,
}: {
  blocks: readonly RenderBlock[];
  results: Record<string, SqlResult>;
  queryErrors: Record<string, string>;
}) {
  // Children render bare (no wrapper) so container components — Grid above
  // all — receive them as direct grid items; containers own their layout.
  const ctx: RenderContext = {
    results,
    renderChildren: (children) => (
      <>
        {children.map((child, i) => (
          <Fragment key={i}>{renderBlock(child, ctx, queryErrors)}</Fragment>
        ))}
      </>
    ),
  };

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => (
        <Fragment key={i}>{renderBlock(block, ctx, queryErrors)}</Fragment>
      ))}
    </div>
  );
}

function renderBlock(
  block: RenderBlock,
  ctx: RenderContext,
  queryErrors: Record<string, string>,
): ReactNode {
  if (block.kind === "markdown") {
    return (
      <div className={MARKDOWN_CLASS}>
        <Markdown remarkPlugins={[remarkGfm]}>{block.text ?? ""}</Markdown>
      </div>
    );
  }
  const failed = block.query ? queryErrors[block.query] : undefined;
  if (block.query && failed !== undefined) {
    return <QueryErrorCard query={block.query} message={failed} />;
  }
  return <ReportComponent block={block} ctx={ctx} />;
}
