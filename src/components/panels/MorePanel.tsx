import { useState } from "react";
import { LayoutGrid, QrCode, Table2, SquarePen } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { QrCodeModal } from "../QrCodeModal";

interface Option {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function MorePanel() {
  const productSlug = useCanvasStore((s) => s.productSlug);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const [qrOpen, setQrOpen] = useState(false);

  // Woven labels are typically too small (≤25 mm short edge) to carry a
  // scannable QR — disable the tool for that product specifically.
  const qrDisabled = productSlug === "woven-labels";

  const options: Option[] = [
    {
      key: "background",
      label: "Background",
      icon: SquarePen,
      onClick: () => setActiveTool("background"),
    },
    {
      key: "template",
      label: "Template",
      icon: LayoutGrid,
      onClick: () => {},
      disabled: true,
      disabledReason: "Coming soon",
    },
    {
      key: "qr",
      label: "QR Code",
      icon: QrCode,
      onClick: () => setQrOpen(true),
      disabled: qrDisabled,
      disabledReason: qrDisabled ? "Not available for woven labels" : undefined,
    },
    {
      key: "tables",
      label: "Tables",
      icon: Table2,
      onClick: () => {},
      disabled: true,
      disabledReason: "Coming soon",
    },
  ];

  return (
    <>
      <div className="space-y-1.5">
        {options.map((o) => {
          const Icon = o.icon;
          return (
            <button
              key={o.key}
              disabled={o.disabled}
              onClick={o.onClick}
              className={[
                "w-full h-12 px-3 rounded-md border text-left flex items-center gap-3 text-sm",
                o.disabled
                  ? "border-vp-border text-vp-muted bg-vp-rail/30 cursor-not-allowed"
                  : "border-vp-border hover:border-vp-blue hover:bg-vp-blue-light text-vp-ink",
              ].join(" ")}
              title={o.disabledReason}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1 font-medium">{o.label}</span>
              {o.disabled && o.disabledReason && (
                <span className="text-[10px] text-vp-muted">
                  {o.disabledReason}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <QrCodeModal open={qrOpen} onClose={() => setQrOpen(false)} />
    </>
  );
}
