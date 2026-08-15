import { useRef, useState } from "react";
import { Plus, Edit2, Trash2, Check, X, BookOpen, Sparkles, Upload, Download, FileAudio } from "lucide-react";
import {
  useListKnowledgeItems, getListKnowledgeItemsQueryKey,
  useUpdateKnowledgeItem, useDeleteKnowledgeItem
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const CATEGORIES = ["model", "price", "offer", "playbook", "stock", "brochure", "faq", "policy", "general"];
const CAT_COLORS: Record<string, string> = {
  model: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  price: "bg-green-500/20 text-green-400 border-green-500/30",
  offer: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  playbook: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  stock: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  brochure: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  faq: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  policy: "bg-red-500/20 text-red-400 border-red-500/30",
  general: "bg-muted text-muted-foreground border-border",
};

const emptyForm = { title: "", category: "general", content: "", modelName: "", fileUrl: "", effectiveFrom: "", effectiveUntil: "" };

export default function Knowledge() {
  const [catFilter, setCatFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  const { data: items, isLoading } = useListKnowledgeItems(
    { category: catFilter || undefined },
    { query: { queryKey: getListKnowledgeItemsQueryKey({ category: catFilter || undefined }) } }
  );
  const update = useUpdateKnowledgeItem();
  const remove = useDeleteKnowledgeItem();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListKnowledgeItemsQueryKey() });
    qc.invalidateQueries({ queryKey: ["knowledge-pending"] });
  }

  // ─── Self-learning review queue ────────────────────────────────────────────
  const adminToken = () => localStorage.getItem("shubham_admin_token") ?? "";
  const adminHeaders = (extra: Record<string, string> = {}) => {
    const t = adminToken();
    return t ? { "X-Admin-Token": t, ...extra } : extra;
  };
  function requireToken(): boolean {
    if (!adminToken()) { toast.error("Set Admin Token in Settings first"); return false; }
    return true;
  }

  type PendingItem = { id: number; title: string; category: string; content: string; evidence: string | null; source: string | null; createdAt: string };
  const pendingQ = useQuery<PendingItem[]>({
    queryKey: ["knowledge-pending"],
    queryFn: async () => {
      const r = await fetch("/api/knowledge/pending", { headers: adminHeaders() });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 30000,
    enabled: !!adminToken(),
  });
  const pending = pendingQ.data ?? [];

  async function approvePending(id: number) {
    if (!requireToken()) return;
    const r = await fetch(`/api/knowledge/${id}/approve`, { method: "POST", headers: adminHeaders() });
    if (r.ok) { toast.success("Approved — added to KB"); invalidate(); } else toast.error("Failed");
  }
  async function rejectPending(id: number) {
    if (!requireToken()) return;
    if (!confirm("Reject and discard this learning?")) return;
    const r = await fetch(`/api/knowledge/${id}/reject`, { method: "POST", headers: adminHeaders() });
    if (r.ok) { toast.success("Rejected"); invalidate(); } else toast.error("Failed");
  }

  // ─── Historical recording upload ───────────────────────────────────────────
  const audioInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);

  async function handleAudioUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!requireToken()) return;
    if (file.size > 25 * 1024 * 1024) { toast.error("File too large (max 25 MB)"); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/knowledge/upload/recording", { method: "POST", headers: adminHeaders(), body: fd });
      const j = await r.json();
      if (r.ok) { toast.success(`Transcribed — ${j.itemsQueuedForReview ?? 0} new learnings queued`); invalidate(); }
      else toast.error(j.error ?? "Upload failed");
    } catch { toast.error("Upload failed"); }
    finally { setUploading(false); }
  }

  async function handleExport() {
    if (!requireToken()) return;
    const r = await fetch("/api/knowledge/export", { headers: adminHeaders() });
    if (!r.ok) { toast.error("Export failed"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `knowledge-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast.success("Exported");
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!requireToken()) return;
    const mode = confirm("Click OK to REPLACE the entire KB with this file.\nClick Cancel to MERGE (add rows alongside existing).") ? "replace" : "merge";
    if (mode === "replace" && !confirm("This will DELETE every existing knowledge row first. Are you absolutely sure?")) return;
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(items)) { toast.error("Invalid file — expected exported JSON"); setImporting(false); return; }
      const r = await fetch("/api/knowledge/import", {
        method: "POST",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mode, items }),
      });
      const j = await r.json();
      if (r.ok) { toast.success(`Imported ${j.imported} rows (${mode})`); invalidate(); }
      else toast.error(j.error ?? "Import failed");
    } catch { toast.error("Import failed — invalid JSON"); }
    finally { setImporting(false); }
  }

  function handleCreate() {
    if (!form.title || !form.content) { toast.error("Title and content required"); return; }
    setCreating(true);
    fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        category: form.category,
        content: form.content,
        modelName: form.modelName || undefined,
        fileUrl: form.fileUrl || undefined,
        effectiveFrom: form.effectiveFrom || undefined,
        effectiveUntil: form.effectiveUntil || undefined,
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        toast.success("Added to knowledge base");
        setAddOpen(false);
        setForm({ ...emptyForm });
        invalidate();
      })
      .catch(() => toast.error("Failed"))
      .finally(() => setCreating(false));
  }

  function startEdit(item: NonNullable<typeof items>[0]) {
    setEditId(item.id);
    setForm({
      title: item.title,
      category: item.category,
      content: item.content,
      modelName: item.modelName ?? "",
      fileUrl: item.fileUrl ?? "",
      effectiveFrom: "",
      effectiveUntil: "",
    });
  }

  function saveEdit() {
    if (!editId) return;
    update.mutate({ id: editId, data: form }, {
      onSuccess: () => { toast.success("Updated"); setEditId(null); invalidate(); },
    });
  }

  function handleDelete(id: number) {
    if (!confirm("Delete this knowledge item?")) return;
    remove.mutate({ id }, { onSuccess: () => { toast.success("Deleted"); invalidate(); } });
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Knowledge Base</h1>
          <p className="text-xs text-muted-foreground mt-0.5">The AI agent's brain — models, prices, offers, FAQs</p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={audioInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm" hidden onChange={handleAudioUpload} />
          <input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={handleImport} />
          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => audioInputRef.current?.click()} disabled={uploading}>
            <FileAudio size={13} />{uploading ? "Transcribing..." : "Upload Call"}
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={handleExport}>
            <Download size={13} />Export
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => importInputRef.current?.click()} disabled={importing}>
            <Upload size={13} />{importing ? "Importing..." : "Import"}
          </Button>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2 text-xs" data-testid="add-knowledge-button"><Plus size={13} />Add Item</Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-card-border max-w-lg">
            <DialogHeader><DialogTitle>Add Knowledge Item</DialogTitle></DialogHeader>
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs mb-1 block">Title *</Label><Input placeholder="e.g. Splendor Plus Price" value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} data-testid="input-knowledge-title" /></div>
                <div>
                  <Label className="text-xs mb-1 block">Category</Label>
                  <Select value={form.category} onValueChange={(v) => setForm(f => ({ ...f, category: v }))}>
                    <SelectTrigger className="text-sm h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div><Label className="text-xs mb-1 block">Content *</Label><textarea className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring min-h-[100px] resize-none" placeholder="Full description, pricing details, specs..." value={form.content} onChange={(e) => setForm(f => ({ ...f, content: e.target.value }))} data-testid="input-knowledge-content" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs mb-1 block">Model Name</Label><Input placeholder="e.g. Splendor Plus" value={form.modelName} onChange={(e) => setForm(f => ({ ...f, modelName: e.target.value }))} /></div>
                <div><Label className="text-xs mb-1 block">File/Brochure URL</Label><Input placeholder="https://..." value={form.fileUrl} onChange={(e) => setForm(f => ({ ...f, fileUrl: e.target.value }))} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs mb-1 block">Effective from</Label><Input type="datetime-local" value={form.effectiveFrom} onChange={(e) => setForm(f => ({ ...f, effectiveFrom: e.target.value }))} /></div>
                <div><Label className="text-xs mb-1 block">Effective until</Label><Input type="datetime-local" value={form.effectiveUntil} onChange={(e) => setForm(f => ({ ...f, effectiveUntil: e.target.value }))} /></div>
              </div>
              <Button className="w-full text-xs" onClick={handleCreate} disabled={creating}>Add to Knowledge Base</Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Self-learning review queue */}
      {pending.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-amber-300">Sakshi learned {pending.length} new thing{pending.length === 1 ? "" : "s"} from recent calls — review</h2>
          </div>
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} data-testid={`pending-${p.id}`} className="bg-card border border-card-border rounded-md p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 uppercase">{p.category}</span>
                      <h3 className="text-sm font-medium truncate">{p.title}</h3>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{p.content}</p>
                    {p.evidence && <p className="text-[11px] italic text-muted-foreground/70 mt-1 border-l-2 border-amber-500/40 pl-2">"{p.evidence}"</p>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => approvePending(p.id)} title="Approve & add to KB" data-testid={`approve-${p.id}`} className="p-1.5 rounded hover:bg-green-500/20 hover:text-green-400 transition-colors"><Check size={14} /></button>
                    <button onClick={() => rejectPending(p.id)} title="Reject & discard" data-testid={`reject-${p.id}`} className="p-1.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors"><X size={14} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setCatFilter("")} className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${!catFilter ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}>All</button>
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => setCatFilter(c)} className={`text-xs px-3 py-1.5 rounded-md border transition-colors capitalize ${catFilter === c ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`} data-testid={`filter-cat-${c}`}>{c}</button>
        ))}
      </div>

      {/* Items grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-32 bg-card border border-card-border rounded-lg animate-pulse" />)}
        </div>
      ) : items && items.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((item) => (
            <div key={item.id} data-testid={`knowledge-item-${item.id}`} className="bg-card border border-card-border rounded-lg p-4 space-y-2 hover:border-border/80 transition-colors">
              {editId === item.id ? (
                <div className="space-y-2">
                  <Input value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} className="text-sm h-8" />
                  <textarea className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring min-h-[60px] resize-none" value={form.content} onChange={(e) => setForm(f => ({ ...f, content: e.target.value }))} />
                  <Input placeholder="File URL" value={form.fileUrl} onChange={(e) => setForm(f => ({ ...f, fileUrl: e.target.value }))} className="text-sm h-8" />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="p-1.5 rounded hover:bg-green-500/20 hover:text-green-400 transition-colors"><Check size={13} /></button>
                    <button onClick={() => setEditId(null)} className="p-1.5 rounded hover:bg-muted transition-colors"><X size={13} /></button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[10px] px-2 py-0.5 rounded border font-medium capitalize shrink-0 ${CAT_COLORS[item.category] ?? CAT_COLORS.general}`}>{item.category}</span>
                      <h3 className="text-sm font-medium truncate">{item.title}</h3>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => startEdit(item)} className="p-1 rounded hover:bg-muted transition-colors" data-testid={`edit-knowledge-${item.id}`}><Edit2 size={12} /></button>
                      <button onClick={() => handleDelete(item.id)} className="p-1 rounded hover:bg-destructive/20 hover:text-destructive transition-colors" data-testid={`delete-knowledge-${item.id}`}><Trash2 size={12} /></button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{item.content}</p>
                  {item.modelName && <div className="text-[10px] text-muted-foreground/70">Model: {item.modelName}</div>}
                  {item.fileUrl && <div className="text-[10px] text-blue-400 truncate"><a href={item.fileUrl} target="_blank" rel="noopener noreferrer">{item.fileUrl}</a></div>}
                  <div className={`flex items-center gap-1 text-[10px] ${item.isActive ? "text-green-400" : "text-muted-foreground"}`}>
                    <div className={`w-1 h-1 rounded-full ${item.isActive ? "bg-green-400" : "bg-muted-foreground"}`} />
                    {item.isActive ? "Active" : "Inactive"}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-card border border-card-border rounded-lg py-20 text-center">
          <BookOpen size={32} className="text-muted-foreground/50 mx-auto mb-3" />
          <div className="text-sm text-muted-foreground">No knowledge items yet.</div>
          <div className="text-xs text-muted-foreground/70 mt-1">Add models, prices, offers, and FAQs to train your AI agent.</div>
        </div>
      )}
    </div>
  );
}
