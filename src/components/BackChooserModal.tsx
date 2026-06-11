import { useCanvasStore } from "@/store/canvasStore";

/**
 * Vistaprint-style "Change the back" chooser.
 *
 * Pops the first time a user clicks the "Back" thumbnail with no
 * existing back design. Three square tiles offer the standard starting
 * points; a fourth Cancel link dismisses without switching sides.
 */
export function BackChooserModal() {
  const open = useCanvasStore((s) => s.backChooserOpen);
  const setOpen = useCanvasStore((s) => s.setBackChooserOpen);
  const initBackDesign = useCanvasStore((s) => s.initBackDesign);

  if (!open) return null;

  const tiles: {
    key: "duplicate" | "blank" | "upload";
    title: string;
    body: string;
    icon: JSX.Element;
  }[] = [
    {
      key: "duplicate",
      title: "Duplicate the front",
      body: "Start the back with an exact copy of the front design.",
      icon: (
        <svg
          viewBox="0 0 48 48"
          className="w-10 h-10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="8" y="12" width="22" height="28" rx="2" />
          <rect x="18" y="8" width="22" height="28" rx="2" />
        </svg>
      ),
    },
    {
      key: "blank",
      title: "Start from blank",
      body: "Begin the back design from a clean, empty canvas.",
      icon: (
        <svg
          viewBox="0 0 48 48"
          className="w-10 h-10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="10" y="8" width="28" height="32" rx="2" />
          <line x1="18" y1="24" x2="30" y2="24" />
          <line x1="24" y1="18" x2="24" y2="30" />
        </svg>
      ),
    },
    {
      key: "upload",
      title: "Upload your design",
      body: "Drop in a print-ready image or PDF for the back side.",
      icon: (
        <svg
          viewBox="0 0 48 48"
          className="w-10 h-10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14 32v6h20v-6" />
          <polyline points="18 20 24 14 30 20" />
          <line x1="24" y1="14" x2="24" y2="32" />
        </svg>
      ),
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="back-chooser-title"
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-white rounded-2xl shadow-vp-pop w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-7 pt-7 pb-4">
          <h2
            id="back-chooser-title"
            className="text-[18px] font-semibold tracking-tight text-vp-ink"
          >
            Change the back
          </h2>
          <p className="text-[12.5px] text-vp-muted mt-1.5">
            Choose how you'd like to start designing the back side.
          </p>
        </header>

        <div className="px-7 pb-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => initBackDesign(t.key)}
              className="group flex flex-col items-start text-left p-4 rounded-xl border border-vp-border hover:border-vp-accent hover:shadow-md hover:-translate-y-0.5 transition-all bg-white text-vp-ink/80 hover:text-vp-ink min-h-[170px]"
            >
              <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center text-vp-accent group-hover:bg-vp-accent/10 transition-colors">
                {t.icon}
              </div>
              <div className="mt-3 text-[13.5px] font-semibold leading-snug">
                {t.title}
              </div>
              <div className="mt-1 text-[11.5px] text-vp-muted leading-snug">
                {t.body}
              </div>
            </button>
          ))}
        </div>

        <footer className="border-t border-gray-100 px-7 py-4 flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-9 px-4 rounded-full text-[12.5px] font-semibold text-vp-ink/70 hover:bg-vp-rail transition-colors"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
