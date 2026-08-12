// Minimal shadcn-styled primitives. Same class conventions as shadcn/ui so you
// can later replace any of these with `npx shadcn add <name>` without touching
// callers. Grouped in one file to keep the tree small.
import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "destructive" | "ghost";
  size?: "sm" | "md";
};

export function Button({ className, variant = "default", size = "md", ...props }: ButtonProps) {
  const variants = {
    default: "bg-primary text-primary-foreground hover:opacity-90",
    outline: "border border-border hover:bg-card",
    destructive: "bg-destructive text-white hover:opacity-90",
    ghost: "hover:bg-card",
  };
  const sizes = { sm: "h-8 px-2.5 text-xs", md: "h-9 px-4 text-sm" };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-muted", className)} {...props} />;
}
