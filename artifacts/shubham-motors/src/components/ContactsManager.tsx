import { useEffect, useState } from "react";
import { Users, Banknote, Plus, Trash2, Phone, Power } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Contact {
  id: number;
  type: "sales" | "finance";
  name: string;
  phone: string;
  bankName: string | null;
  isActive: boolean;
}

const FINANCE_BANKS = ["HDFC Bank", "Hero FinCorp", "IDBI Bank", "Hinduja Leyland Finance", "RBL Bank"];

export default function ContactsManager() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  // sales draft
  const [salesName, setSalesName] = useState("");
  const [salesPhone, setSalesPhone] = useState("");
  // finance draft
  const [bank, setBank] = useState(FINANCE_BANKS[0]);
  const [finName, setFinName] = useState("");
  const [finPhone, setFinPhone] = useState("");

  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const adminToken = () => localStorage.getItem("shubham_admin_token") ?? "";
  const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const t = adminToken();
    return t ? { "X-Admin-Token": t, ...extra } : extra;
  };

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/contacts`, { headers: authHeaders() });
      if (r.ok) setContacts(await r.json());
      else if (r.status === 401) toast.error("Set Admin Token below to view contacts");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function checkToken(): boolean {
    if (!adminToken()) { toast.error("Set Admin Token (below) first"); return false; }
    return true;
  }

  async function addSales() {
    if (!checkToken()) return;
    if (!salesName.trim() || !salesPhone.trim()) { toast.error("Name and phone required"); return; }
    const r = await fetch(`${base}/api/contacts`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ type: "sales", name: salesName.trim(), phone: salesPhone.trim() }),
    });
    if (!r.ok) { toast.error("Failed to add"); return; }
    toast.success("Sales contact added");
    setSalesName(""); setSalesPhone(""); void load();
  }

  async function addFinance() {
    if (!checkToken()) return;
    if (!finName.trim() || !finPhone.trim()) { toast.error("Name and phone required"); return; }
    const r = await fetch(`${base}/api/contacts`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ type: "finance", name: finName.trim(), phone: finPhone.trim(), bankName: bank }),
    });
    if (!r.ok) { toast.error("Failed to add"); return; }
    toast.success(`${bank} contact added`);
    setFinName(""); setFinPhone(""); void load();
  }

  async function toggleActive(c: Contact) {
    if (!checkToken()) return;
    const r = await fetch(`${base}/api/contacts/${c.id}`, {
      method: "PATCH", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ isActive: !c.isActive }),
    });
    if (r.ok) { toast.success(c.isActive ? "Disabled" : "Enabled"); void load(); }
  }

  async function remove(c: Contact) {
    if (!checkToken()) return;
    if (!confirm(`Delete ${c.name} (${c.phone})?`)) return;
    const r = await fetch(`${base}/api/contacts/${c.id}`, { method: "DELETE", headers: authHeaders() });
    if (r.ok) { toast.success("Deleted"); void load(); }
  }

  const sales = contacts.filter(c => c.type === "sales");
  const finance = contacts.filter(c => c.type === "finance");

  return (
    <div className="space-y-5">
      {/* SALES TEAM */}
      <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary"><Users size={16} /></div>
          <div className="flex-1">
            <div className="text-sm font-semibold">Sales Team Transfer Numbers</div>
            <div className="text-xs text-muted-foreground">Add every salesperson. When a customer asks for a human, all <strong>Active</strong> numbers ring together. Whoever picks up is saved on Call Detail → Transferred To.</div>
          </div>
        </div>

        <div className="pl-10 grid grid-cols-[1fr_180px_auto] gap-2 items-end">
          <div>
            <Label className="text-xs mb-1 block">Salesperson name</Label>
            <Input placeholder="Rahul Sharma" value={salesName} onChange={e => setSalesName(e.target.value)} className="text-sm" data-testid="input-sales-name" />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Mobile number</Label>
            <Input placeholder="9876543210" value={salesPhone} onChange={e => setSalesPhone(e.target.value)} className="text-sm font-mono" data-testid="input-sales-phone" />
          </div>
          <Button size="sm" onClick={addSales} className="gap-1.5"><Plus size={12} />Add</Button>
        </div>

        <div className="pl-10 space-y-1.5">
          {loading ? <div className="text-xs text-muted-foreground">Loading…</div> :
            sales.length === 0 ? <div className="text-xs text-muted-foreground italic">No sales contacts yet. Add one above.</div> :
            sales.map(c => (
              <ContactRow key={c.id} c={c} onToggle={() => toggleActive(c)} onDelete={() => remove(c)} />
            ))}
        </div>
      </div>

      {/* FINANCE PARTNERS */}
      <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary"><Banknote size={16} /></div>
          <div className="flex-1">
            <div className="text-sm font-semibold">Finance Partner Contacts</div>
            <div className="text-xs text-muted-foreground">When customer asks for exact EMI / loan approval, Sakshi says <code className="font-mono">[TRANSFER:FINANCE:HDFC]</code> and routes to that bank's contact.</div>
          </div>
        </div>

        <div className="pl-10 grid grid-cols-[160px_1fr_180px_auto] gap-2 items-end">
          <div>
            <Label className="text-xs mb-1 block">Bank</Label>
            <select value={bank} onChange={e => setBank(e.target.value)} className="w-full h-9 text-sm bg-background border border-input rounded-md px-2" data-testid="select-bank">
              {FINANCE_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Contact person</Label>
            <Input placeholder="Amit Verma" value={finName} onChange={e => setFinName(e.target.value)} className="text-sm" data-testid="input-fin-name" />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Mobile number</Label>
            <Input placeholder="9876543210" value={finPhone} onChange={e => setFinPhone(e.target.value)} className="text-sm font-mono" data-testid="input-fin-phone" />
          </div>
          <Button size="sm" onClick={addFinance} className="gap-1.5"><Plus size={12} />Add</Button>
        </div>

        <div className="pl-10 space-y-1.5">
          {loading ? <div className="text-xs text-muted-foreground">Loading…</div> :
            finance.length === 0 ? <div className="text-xs text-muted-foreground italic">No finance contacts yet. Add one above.</div> :
            finance.map(c => (
              <ContactRow key={c.id} c={c} onToggle={() => toggleActive(c)} onDelete={() => remove(c)} />
            ))}
        </div>
      </div>
    </div>
  );
}

function ContactRow({ c, onToggle, onDelete }: { c: Contact; onToggle: () => void; onDelete: () => void }) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-md border ${c.isActive ? "bg-background border-border" : "bg-muted/30 border-border/50 opacity-60"}`}>
      <Phone size={12} className="text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{c.name} {c.bankName && <span className="text-xs text-muted-foreground">· {c.bankName}</span>}</div>
        <div className="text-xs font-mono text-muted-foreground">{c.phone}</div>
      </div>
      <Button size="sm" variant="ghost" onClick={onToggle} className="h-7 px-2 gap-1" data-testid={`toggle-contact-${c.id}`}>
        <Power size={11} />{c.isActive ? "Active" : "Off"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete} className="h-7 px-2 text-destructive" data-testid={`delete-contact-${c.id}`}>
        <Trash2 size={11} />
      </Button>
    </div>
  );
}
