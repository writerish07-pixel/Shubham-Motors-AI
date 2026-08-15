import { useEffect, useRef, useState } from "react";
import { Settings2, Phone, MessageSquare, Mic, Bot, CheckCircle, Upload, FileSpreadsheet, Key, AlertCircle, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import ContactsManager from "@/components/ContactsManager";

const ADMIN_TOKEN_KEY = "shubham_admin_token";

export default function Settings() {
  const [adminToken, setAdminToken] = useState("");
  const [stockBusy, setStockBusy] = useState(false);
  const [priceBusy, setPriceBusy] = useState(false);
  const [offerBusy, setOfferBusy] = useState(false);
  const [lastStock, setLastStock] = useState<string>("");
  const [lastPrice, setLastPrice] = useState<string>("");
  const [lastOffer, setLastOffer] = useState<string>("");
  const stockInputRef = useRef<HTMLInputElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const offerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAdminToken(localStorage.getItem(ADMIN_TOKEN_KEY) ?? "");
    setLastStock(localStorage.getItem("shubham_last_stock_upload") ?? "");
    setLastPrice(localStorage.getItem("shubham_last_price_upload") ?? "");
    setLastOffer(localStorage.getItem("shubham_last_offer_upload") ?? "");
  }, []);

  function saveToken() {
    localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
    toast.success("Admin token saved on this device");
  }

  async function upload(kind: "stock" | "price" | "offer-image", file: File) {
    if (!adminToken) { toast.error("Set the Admin Token first"); return; }
    const setBusy = kind === "stock" ? setStockBusy : kind === "price" ? setPriceBusy : setOfferBusy;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
      const r = await fetch(`${base}/api/knowledge/upload/${kind}`, {
        method: "POST",
        headers: { "X-Admin-Token": adminToken },
        body: fd,
      });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error ?? `Upload failed (${r.status})`); return; }
      if (kind === "offer-image") {
        toast.success(`Offer extracted — ${j.items?.length ?? 0} offer(s) added to knowledge base`);
        const stamp = `${file.name} · ${j.items?.length ?? 0} offer(s) · ${new Date().toLocaleString()}`;
        setLastOffer(stamp); localStorage.setItem("shubham_last_offer_upload", stamp);
      } else {
        toast.success(`${kind === "stock" ? "Stock" : "Price list"} updated — ${j.models} models loaded`);
        const stamp = `${file.name} · ${new Date().toLocaleString()}`;
        if (kind === "stock") { setLastStock(stamp); localStorage.setItem("shubham_last_stock_upload", stamp); }
        else { setLastPrice(stamp); localStorage.setItem("shubham_last_price_upload", stamp); }
      }
    } catch (err) {
      toast.error("Upload error: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sections = [
    {
      icon: <Phone size={16} />, title: "Exotel Voice Configuration",
      desc: "Virtual number and API credentials for call handling",
      fields: [
        { label: "Virtual Number", placeholder: "Your Exotel virtual number", env: "EXOTEL_VIRTUAL_NUMBER" },
        { label: "Account SID", placeholder: "Exotel SID", env: "EXOTEL_SID" },
        { label: "API Key", placeholder: "Exotel API Key", env: "EXOTEL_API_KEY" },
      ],
    },
    { icon: <Mic size={16} />, title: "Sarvam AI (STT/TTS)", desc: "Speech-to-text and text-to-speech for multilingual voice",
      fields: [{ label: "API Key", placeholder: "Sarvam API subscription key", env: "SARVAM_API_KEY" }] },
    { icon: <MessageSquare size={16} />, title: "BotSpace WhatsApp", desc: "WhatsApp messaging for call summaries and brochures",
      fields: [
        { label: "API Key", placeholder: "BotSpace API key", env: "BOTSPACE_API_KEY" },
        { label: "Phone Number ID", placeholder: "WhatsApp Phone Number ID", env: "BOTSPACE_PHONE_NUMBER_ID" },
      ] },
    { icon: <Bot size={16} />, title: "AI Brain (OpenAI)", desc: "GPT model for intent detection, scoring, and self-learning",
      fields: [{ label: "OpenAI API Key", placeholder: "sk-...", env: "OPENAI_API_KEY" }] },
    { icon: <Phone size={16} />, title: "Sales Transfer", desc: "When a lead goes hot, AI transfers the call to your salesperson",
      fields: [{ label: "Sales Person Number", placeholder: "10-digit mobile for hot lead transfers", env: "SALES_TRANSFER_NUMBER" }] },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2"><Settings2 size={20} />Settings</h1>
        <p className="text-xs text-muted-foreground mt-1">Configure your AI voice agent integrations and update product data</p>
      </div>

      {/* ── SALES & FINANCE TRANSFER CONTACTS ───────────────────────────── */}
      <div className="bg-card border border-primary/30 rounded-lg p-5 space-y-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary"><Users size={16} /></div>
          <div className="flex-1">
            <div className="text-sm font-semibold">Sales Team &amp; Finance Partners</div>
            <div className="text-xs text-muted-foreground">Names &amp; phone numbers Sakshi uses for live call transfer. Sales for negotiations &amp; objections, finance for loan approvals &amp; exact EMI.</div>
          </div>
        </div>
        <ContactsManager />
      </div>

      {/* ── DAILY / MONTHLY DATA UPLOADS ───────────────────────────────────── */}
      <div className="bg-card border border-primary/30 rounded-lg p-5 space-y-4">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary">
            <FileSpreadsheet size={16} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">Product Data Uploads</div>
            <div className="text-xs text-muted-foreground">
              Upload the daily STOCK Excel and the monthly PRICE LIST. Files are validated
              and committed atomically — your knowledge base is never wiped if the file is malformed.
            </div>
          </div>
        </div>

        {/* Admin token entry */}
        <div className="pl-10 space-y-2">
          <Label className="text-xs flex items-center gap-1.5 text-muted-foreground"><Key size={11} /> Admin Token (saved on this device)</Label>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="Paste the ADMIN_TOKEN value from server secrets"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              className="text-sm font-mono"
              data-testid="input-admin-token"
            />
            <Button size="sm" onClick={saveToken} disabled={!adminToken}>Save</Button>
          </div>
          <div className="text-[10px] text-muted-foreground/70">
            Set the matching value as the server env <code className="font-mono">ADMIN_TOKEN</code> (Fly secrets). Required for uploads.
          </div>
        </div>

        {/* Stock upload */}
        <div className="pl-10 space-y-2 pt-2 border-t border-border/50">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">Daily Stock Upload</Label>
              <div className="text-[10px] text-muted-foreground">Columns: Model | SKU | SKU Description | SKU wise Inventory Qty</div>
            </div>
            <Button size="sm" variant="outline" disabled={stockBusy || !adminToken} onClick={() => stockInputRef.current?.click()} className="gap-1.5 text-xs">
              <Upload size={12} />{stockBusy ? "Uploading…" : "Upload Stock .xlsx"}
            </Button>
            <input ref={stockInputRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload("stock", f); e.target.value = ""; }}
              data-testid="input-stock-file" />
          </div>
          {lastStock && <div className="text-[10px] text-green-400 flex items-center gap-1"><CheckCircle size={10} />Last: {lastStock}</div>}
        </div>

        {/* Price upload */}
        <div className="pl-10 space-y-2 pt-2 border-t border-border/50">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">Monthly Price List Upload</Label>
              <div className="text-[10px] text-muted-foreground">Columns: S.NO | MODEL | EX. SHOWROOM | RC | Insurance | … | On Road Price | ACC.KIT | Total</div>
            </div>
            <Button size="sm" variant="outline" disabled={priceBusy || !adminToken} onClick={() => priceInputRef.current?.click()} className="gap-1.5 text-xs">
              <Upload size={12} />{priceBusy ? "Uploading…" : "Upload Price .xlsx"}
            </Button>
            <input ref={priceInputRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload("price", f); e.target.value = ""; }}
              data-testid="input-price-file" />
          </div>
          {lastPrice && <div className="text-[10px] text-green-400 flex items-center gap-1"><CheckCircle size={10} />Last: {lastPrice}</div>}
        </div>

        {/* Offer image upload — uses GPT-4o vision to read marketing flyers */}
        <div className="pl-10 space-y-2 pt-2 border-t border-border/50">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">Offer / Scheme Image Upload</Label>
              <div className="text-[10px] text-muted-foreground">Upload any offer flyer (JPG/PNG) — AI reads it, computes rupee amounts, adds to knowledge base</div>
            </div>
            <Button size="sm" variant="outline" disabled={offerBusy || !adminToken} onClick={() => offerInputRef.current?.click()} className="gap-1.5 text-xs">
              <Upload size={12} />{offerBusy ? "Reading…" : "Upload Offer Image"}
            </Button>
            <input ref={offerInputRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload("offer-image", f); e.target.value = ""; }}
              data-testid="input-offer-file" />
          </div>
          {lastOffer && <div className="text-[10px] text-green-400 flex items-center gap-1"><CheckCircle size={10} />Last: {lastOffer}</div>}
        </div>

        {!adminToken && (
          <div className="ml-10 flex items-start gap-2 text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded px-2.5 py-1.5">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            <div>Set the Admin Token above before uploading. Add the same value as server env <code className="font-mono">ADMIN_TOKEN</code>.</div>
          </div>
        )}
      </div>

      {/* ── INTEGRATION CREDENTIALS (read-only — managed via Secrets) ─────── */}
      <div className="bg-card border border-card-border rounded-lg p-4 text-sm text-foreground/80">
        <div className="flex items-start gap-2">
          <CheckCircle size={14} className="text-green-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-sm">API credentials are stored as environment secrets</div>
            <div className="text-xs text-muted-foreground mt-0.5">Update them via Fly.io / host secrets — values shown here are masked for security.</div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.title} className="bg-card border border-card-border rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center text-muted-foreground">{section.icon}</div>
              <div>
                <div className="text-sm font-semibold">{section.title}</div>
                <div className="text-xs text-muted-foreground">{section.desc}</div>
              </div>
            </div>
            <div className="space-y-3 pl-10">
              {section.fields.map((f) => (
                <div key={f.env}>
                  <Label className="text-xs mb-1 block text-muted-foreground">{f.label}</Label>
                  <Input type="password" placeholder={f.placeholder} defaultValue="••••••••••••••••" className="text-sm font-mono" data-testid={`setting-${f.env.toLowerCase()}`} readOnly />
                  <div className="text-[10px] text-muted-foreground/60 mt-0.5">Env: <code className="font-mono">{f.env}</code> — update via server secrets</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Webhook info */}
      <div className="bg-card border border-card-border rounded-lg p-5 space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center text-muted-foreground"><Phone size={16} /></div>
          <div>
            <div className="text-sm font-semibold">Exotel Webhook URLs</div>
            <div className="text-xs text-muted-foreground">Configure these in your Exotel dashboard</div>
          </div>
        </div>
        <div className="pl-10 space-y-2">
          {[
            { label: "Inbound Call URL", path: "/api/webhooks/exotel/inbound" },
            { label: "Call Status URL", path: "/api/webhooks/exotel/status" },
            { label: "Voice Stream URL (Voicebot applet)", path: "/call/stream" },
          ].map(({ label, path }) => (
            <div key={path}>
              <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
              <div className="text-xs font-mono bg-muted/50 px-3 py-1.5 rounded border border-border text-foreground/80 break-all">
                {`https://[your-domain]${path}`}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
