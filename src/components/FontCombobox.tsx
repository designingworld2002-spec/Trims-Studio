import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { SmartPopover } from "./SmartPopover";
import { FONTS, type FontDef } from "@/lib/fonts";

/**
 * Searchable font picker.
 *
 * Replaces the old plain `<Dropdown>` so the user can scan / filter 25+
 * fonts quickly. Each row previews itself in its own typeface so the user
 * sees what they'll get before clicking.
 *
 * Built on `SmartPopover`, so the menu is portal-rendered, never gets
 * clipped by parent overflow, and flips above the trigger / scrolls
 * within `maxHeight` automatically — important on mobile where the
 * canvas-area popovers used to disappear under the bottom toolbar.
 */
export function FontCombobox({
  value,
  onChange,
  width = 176,
}: {
  value: string;
  onChange: (family: string) => void;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FONTS;
    return FONTS.filter((f) => f.family.toLowerCase().includes(q));
  }, [query]);

  const select = (f: FontDef) => {
    onChange(f.family);
    setOpen(false);
    setQuery("");
  };

  return (
    <SmartPopover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setQuery("");
      }}
      className="w-64"
      align="auto"
      side="auto"
      trigger={
        <button
          type="button"
          aria-label="Font family"
          aria-expanded={open}
          className="h-7 px-2 rounded border border-vp-border text-sm flex items-center justify-between hover:border-vp-blue bg-white"
          style={{ width, fontFamily: value }}
          title={value}
        >
          <span className="truncate text-left">{value}</span>
          <ChevronDown className="w-3.5 h-3.5 text-vp-muted ml-1 shrink-0" />
        </button>
      }
    >
      <div className="p-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-vp-muted pointer-events-none" />
          <input
            type="text"
            autoFocus
            placeholder="Search fonts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-8 pl-7 pr-2 rounded border border-vp-border text-sm focus:outline-none focus:border-vp-blue"
          />
        </div>
      </div>
      <div className="border-t border-vp-border py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-xs text-vp-muted text-center">
            No fonts match "{query}"
          </div>
        ) : (
          filtered.map((f) => {
            const active = f.family === value;
            return (
              <button
                key={f.family}
                onClick={() => select(f)}
                className={[
                  "w-full px-3 py-1.5 text-sm text-left flex items-center justify-between",
                  active
                    ? "bg-vp-blue-light text-vp-blue"
                    : "hover:bg-vp-rail",
                ].join(" ")}
                style={{ fontFamily: f.family }}
              >
                <span className="truncate">{f.family}</span>
                {f.system && (
                  <span
                    className="text-[10px] uppercase tracking-wide text-vp-muted ml-2 shrink-0"
                    style={{ fontFamily: "system-ui, sans-serif" }}
                  >
                    system
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </SmartPopover>
  );
}
