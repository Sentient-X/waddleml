/* One inline error card for report surfaces — a compile/render failure with its
   machine `code` (report_bad_query, report_name_taken, …) and message. Used by
   both the view and the editor so a 422 is never a silent dead button. */

import { AlertTriangle } from "lucide-react";

export function ErrorBanner({ code, message }: { code?: string | null; message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        {code ? (
          <span className="mr-2 font-mono text-xs uppercase text-destructive">{code}</span>
        ) : null}
        <span className="text-destructive">{message}</span>
      </div>
    </div>
  );
}
