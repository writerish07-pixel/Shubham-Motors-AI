import { useState, useRef } from "react";
import { Link } from "wouter";
import { Search, Plus, Upload, Phone, Trash2, ChevronRight, RefreshCw } from "lucide-react";
import {
  useListLeads, useCreateLead, useImportLeads, useDeleteLead, useTriggerOutboundCall,
  getListLeadsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScoreBadge, StatusBadge } from "@/components/ScoreBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const STATUSES = ["", "new", "contacted", "interested", "hot", "converted", "lost"];

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes ("")
// and commas / newlines inside quotes. A naive line.split(",") corrupts any
// address or note that contains a comma.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

export default function Leads() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", interestedModel: "", source: "", notes: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const { data: leads, isLoading } = useListLeads({ search: search || undefined, status: statusFilter || undefined });
  const createLead = useCreateLead();
  const importLeads = useImportLeads();
  const deleteLead = useDeleteLead();
  const triggerCall = useTriggerOutboundCall();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
  }

  async function handleCreate() {
    if (!form.name || !form.phone) { toast.error("Name and phone required"); return; }
    createLead.mutate({ data: form }, {
      onSuccess: () => { toast.success("Lead added"); setAddOpen(false); setForm({ name: "", phone: "", email: "", interestedModel: "", source: "", notes: "" }); invalidate(); },
      onError: () => toast.error("Failed to add lead"),
    });
  }

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) { toast.error("CSV has no data rows"); e.target.value = ""; return; }
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const leadsData = rows.slice(1).map((vals) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] ?? "").trim(); });
      return { name: obj["name"] || obj["full name"] || "", phone: obj["phone"] || obj["mobile"] || obj["number"] || "", email: obj["email"] || "", interestedModel: obj["model"] || obj["interested model"] || "", source: obj["source"] || "csv_import" };
    }).filter((l) => l.name && l.phone);
    importLeads.mutate({ data: { leads: leadsData } }, {
      onSuccess: (result) => { toast.success(`Imported ${result.imported} leads (${result.failed} failed)`); invalidate(); },
      onError: () => toast.error("Import failed"),
    });
    e.target.value = "";
  }

  function handleCall(id: number, name: string) {
    triggerCall.mutate({ id }, {
      onSuccess: (r) => { r.success ? toast.success(`Calling ${name}...`) : toast.error("Call failed to initiate"); },
    });
  }

  function handleDelete(id: number) {
    if (!confirm("Delete this lead?")) return;
    deleteLead.mutate({ id }, {
      onSuccess: () => { toast.success("Lead deleted"); invalidate(); },
    });
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Leads</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} className="gap-2 text-xs" data-testid="import-leads-button">
            <Upload size={13} /> Import CSV
          </Button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileImport} />
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-2 text-xs" data-testid="add-lead-button"><Plus size={13} /> Add Lead</Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-card-border">
              <DialogHeader><DialogTitle>Add New Lead</DialogTitle></DialogHeader>
              <div className="space-y-3 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div><Label className="text-xs mb-1 block">Name *</Label><Input placeholder="Full name" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} data-testid="input-lead-name" /></div>
                  <div><Label className="text-xs mb-1 block">Phone *</Label><Input placeholder="10-digit mobile" value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} data-testid="input-lead-phone" /></div>
                </div>
                <div><Label className="text-xs mb-1 block">Email</Label><Input placeholder="Email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} /></div>
                <div><Label className="text-xs mb-1 block">Interested Model</Label><Input placeholder="e.g. Splendor Plus, Xtreme 160R" value={form.interestedModel} onChange={(e) => setForm(f => ({ ...f, interestedModel: e.target.value }))} /></div>
                <div><Label className="text-xs mb-1 block">Source</Label><Input placeholder="e.g. walk-in, website, referral" value={form.source} onChange={(e) => setForm(f => ({ ...f, source: e.target.value }))} /></div>
                <div><Label className="text-xs mb-1 block">Notes</Label><Input placeholder="Any notes" value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
                <Button className="w-full" onClick={handleCreate} disabled={createLead.isPending} data-testid="button-submit-lead">
                  {createLead.isPending ? "Adding..." : "Add Lead"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9 text-sm h-9" placeholder="Search name or phone..." value={search} onChange={(e) => setSearch(e.target.value)} data-testid="search-leads" />
        </div>
        <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36 h-9 text-sm" data-testid="filter-status"><SelectValue placeholder="All Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {STATUSES.filter(Boolean).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={invalidate} className="h-9 w-9 p-0"><RefreshCw size={14} /></Button>
      </div>

      {/* Table */}
      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Phone</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Model</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Score</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell">Next Follow-up</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse w-full" /></td></tr>
                ))
              ) : leads && leads.length > 0 ? leads.map((lead) => (
                <tr key={lead.id} data-testid={`lead-row-${lead.id}`} className="hover:bg-muted/30 transition-colors group">
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`}>
                      <span className="font-medium text-foreground group-hover:text-primary cursor-pointer transition-colors">{lead.name}</span>
                    </Link>
                    {lead.intentSummary && <div className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[180px]">{lead.intentSummary}</div>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{lead.phone}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{lead.interestedModel ?? "—"}</td>
                  <td className="px-4 py-3"><ScoreBadge score={lead.score} /></td>
                  <td className="px-4 py-3"><StatusBadge status={lead.status} /></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                    {lead.nextFollowupAt ? new Date(lead.nextFollowupAt).toLocaleDateString("en-IN") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => handleCall(lead.id, lead.name)} className="p-1.5 rounded hover:bg-primary/20 hover:text-primary transition-colors" data-testid={`call-lead-${lead.id}`} title="Call now">
                        <Phone size={13} />
                      </button>
                      <Link href={`/leads/${lead.id}`}>
                        <button className="p-1.5 rounded hover:bg-muted transition-colors" data-testid={`view-lead-${lead.id}`} title="View detail">
                          <ChevronRight size={13} />
                        </button>
                      </Link>
                      <button onClick={() => handleDelete(lead.id)} className="p-1.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors" data-testid={`delete-lead-${lead.id}`} title="Delete">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground text-sm">No leads found. Add or import leads to get started.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {leads && <div className="text-xs text-muted-foreground">{leads.length} lead{leads.length !== 1 ? "s" : ""}</div>}
    </div>
  );
}
