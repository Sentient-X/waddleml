import type { ButtonHTMLAttributes } from "react";

import { cn } from "@sx/ui";

export function ResearchListRow({
  selected = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "w-full border-l-2 border-transparent px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "border-l-foreground bg-muted/70",
        className,
      )}
      {...props}
    />
  );
}
