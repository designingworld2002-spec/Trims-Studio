import { useState } from "react";
import {
  LayoutGrid,
  QrCode,
  Table2,
  SquarePen,
  Barcode,
  Shirt,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { MATERIAL_CONFIGURABLE_HANDLES } from "@/config/productConfig";
import { QrCodeModal } from "../QrCodeModal";
import { BarcodeModal } from "../BarcodeModal";
import { TableModal } from "../TableModal";
import { WashcareModal } from "../WashcareModal";

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
  const productHandle = useCanvasStore((s) => s.productConfig.handle);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const [qrOpen, setQrOpen] = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [washcareOpen, setWashcareOpen] = useState(false);

  // Woven manufacturing is too fine to carry a scannable QR / barcode —
  // disable both. This is true for the woven-labels PRODUCT (checked via
  // URL slug + resolved handle so aliases are caught), and ALSO when the
  // user picks the "Woven" material for a material-configurable product
  // (washcare / size labels) — the material dictates the feature set.
  const material = useCanvasStore((s) => s.material);
  const wovenByMaterial =
    material === "Woven" &&
    MATERIAL_CONFIGURABLE_HANDLES.includes(productHandle);
  const isWoven =
    productSlug === "woven-labels" ||
    productHandle === "woven-labels" ||
    wovenByMaterial;
  const qrDisabled = isWoven;
  const barcodeDisabled = isWoven;

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
    // Barcode — available to ALL products except woven labels.
    {
      key: "barcode",
      label: "Barcode",
      icon: Barcode,
      onClick: () => setBarcodeOpen(true),
      disabled: barcodeDisabled,
      disabledReason: barcodeDisabled
        ? "Not available for woven labels"
        : undefined,
    },
    // Washcare Signs — universally available for every product.
    {
      key: "washcare",
      label: "Washcare Signs",
      icon: Shirt,
      onClick: () => setWashcareOpen(true),
    },
    {
      key: "tables",
      label: "Tables",
      icon: Table2,
      onClick: () => setTableOpen(true),
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
      <BarcodeModal open={barcodeOpen} onClose={() => setBarcodeOpen(false)} />
      <WashcareModal
        open={washcareOpen}
        onClose={() => setWashcareOpen(false)}
      />
      <TableModal open={tableOpen} onClose={() => setTableOpen(false)} />
    </>
  );
}
