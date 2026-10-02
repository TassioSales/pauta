import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { initials } from "../lib/identity";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "plain" | "dark" | "ghost";
  size?: "sm" | "md";
  icon?: ReactNode;
};

export function Button({ variant = "plain", size = "md", icon, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap transition-transform",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-10 px-4 text-sm",
        variant !== "ghost" && "border-2 border-ink shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
        variant === "primary" && "bg-red text-white hover:bg-[#c01f33]",
        variant === "plain" && "bg-paper hover:bg-wash",
        variant === "dark" && "bg-ink text-paper hover:bg-[#2a2a2a]",
        variant === "ghost" && "text-ink-2 hover:bg-ink/8 hover:text-ink",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** A toolbar key: it keeps the editor's selection because it never takes the focus. */
export function Key({ label, active, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      {...rest}
      className={clsx(
        "inline-flex h-8 min-w-8 items-center justify-center gap-1.5 px-2 text-[13px] font-semibold transition-colors disabled:opacity-35",
        active ? "bg-ink text-paper" : "text-ink-2 hover:bg-ink/8 hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Avatar({ name, color, size = 28, title }: { name: string; color: string; size?: number; title?: string }) {
  return (
    <span title={title ?? name} className="inline-grid shrink-0 place-items-center rounded-full border-2 border-ink font-sans font-bold text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}>
      {initials(name) || "?"}
    </span>
  );
}

export const inputClass = "h-10 w-full border-2 border-ink bg-paper px-3 text-sm placeholder:text-ink-3 focus:outline-none focus:ring-4 focus:ring-red/25";

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("border-2 border-ink bg-paper shadow-hard", className)}>{children}</div>;
}

/** The wordmark: a note on a staff. */
export function Logo({ small }: { small?: boolean }) {
  return (
    <span className={clsx("inline-flex items-center gap-2 font-display font-bold tracking-tight", small ? "text-xl" : "text-3xl")}>
      <svg viewBox="0 0 32 32" className={small ? "size-6" : "size-8"} aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.4" opacity=".4">
          <path d="M2 8h28M2 13h28M2 18h28M2 23h28M2 28h28" />
        </g>
        <ellipse cx="13" cy="23" rx="5" ry="3.8" fill="#d6293e" transform="rotate(-20 13 23)" />
        <path d="M17.5 22V5" stroke="#d6293e" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      pauta
    </span>
  );
}

const time = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
export const when = (ms: number) => (ms ? time.format(ms) : "");
