import { useState } from "react";
import { Megaphone, Plus, Play, Trash2, Eye, Users, CheckCircle2, XCircle, Clock, Send } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number;
  name: string;
  messageTemplate: string;
  status: string;
  filterStatus: string[];
  filterScoreMin: number;
  filterScoreMax: number;
  filterModel: string | null;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PreviewResult {
  count: number;
  leads: Array<{ id: number; name: string; phone: string; status: string; score: number }>;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${BASE}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null;
  return r.json();
}

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  running: "bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
};

function CampaignBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border capitalize", STATUS_STYLES[status] ?? STATUS_STYLES.draft)}>
      {status}
    </span>
  );
}

// ── Empty form ────────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  messageTemplate: "Hello {name}! 👋\n\nThis is Shubham Motors (Hero MotoCorp). We have an exclusive offer for you on the Hero {model}!\n\n🏍️ Visit us for a test ride and special festival discount.\n📍 Shubham Motors Showroom\n\nReply STOP to opt out.",
  filterStatus: [] as string[],
  filterScoreMin: 0,
  filterScoreMax: 100,
  filterModel: "",
};

const ALL_STATUSES = ["new", "contacted", "interested", "hot", "followup"];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Campaigns() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: campaigns, isLoading } = useQuery<Campaign[]>({
    queryKey: ["campaigns"],
    queryFn: () => apiFetch("/campaigns"),
    refetchInterval: 5000,
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof EMPTY_FORM) => apiFetch("/campaigns", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success("Campaign created");
      setAddOpen(false);
      setForm({ ...EMPTY_FORM });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: () => toast.error("Failed to create campaign"),
  });

  const sendMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/campaigns/${id}/send`, { method: "POST" }),
    onSuccess: (_, id) => {
      toast.success("Campaign blast started!");
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      setPreviewId(null);
    },
    onError: () => toast.error("Failed to send campaign"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Campaign deleted");
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  async function handlePreview(id: number) {
    setPreviewId(id);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const data = await apiFetch(`/campaigns/${id}/preview`, { method: "POST" });
      setPreviewData(data);
    } catch {
      toast.error("Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  function toggleStatus(s: string) {
    setForm(f => ({
      ...f,
      filterStatus: f.filterStatus.includes(s)
        ? f.filterStatus.filter(x => x !== s)
        : [...f.filterStatus, s],
    }));
  }

  const charCount = form.messageTemplate.length;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Megaphone size={20} className="text-primary" />
            Blast Campaigns
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">Send WhatsApp messages to filtered lead segments</p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2 text-xs" data-testid="create-campaign-button">
              <Plus size={13} />Create Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-card-border max-w-xl">
            <DialogHeader><DialogTitle>New Blast Campaign</DialogTitle></DialogHeader>
            <div className="space-y-4 pt-2">
              {/* Name */}
              <div>
                <Label className="text-xs mb-1 block">Campaign Name *</Label>
                <Input
                  placeholder="e.g. Diwali Offer Blast, Splendor Plus Launch"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  data-testid="input-campaign-name"
                />
              </div>

              {/* Message template */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs">WhatsApp Message Template *</Label>
                  <span className="text-[10px] text-muted-foreground">{charCount}/1024 chars</span>
                </div>
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring min-h-[140px] resize-none font-mono"
                  value={form.messageTemplate}
                  onChange={e => setForm(f => ({ ...f, messageTemplate: e.target.value.slice(0, 1024) }))}
                  data-testid="input-campaign-message"
                />
                <div className="flex gap-2 mt-1 flex-wrap">
                  {["{name}", "{phone}", "{model}"].map(v => (
                    <button
                      key={v}
                      onClick={() => setForm(f => ({ ...f, messageTemplate: f.messageTemplate + v }))}
                      className="text-[10px] px-2 py-0.5 rounded border border-primary/40 text-primary hover:bg-primary/10 transition-colors font-mono"
                    >
                      {v}
                    </button>
                  ))}
                  <span className="text-[10px] text-muted-foreground self-center">← click to insert variable</span>
                </div>
              </div>

              {/* Audience filters */}
              <div className="space-y-3 bg-muted/20 rounded-md p-3 border border-border">
                <div className="text-xs font-semibold text-foreground">Target Audience Filters</div>

                <div>
                  <Label className="text-xs mb-1.5 block text-muted-foreground">Lead Status (select all that apply)</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_STATUSES.map(s => (
                      <button
                        key={s}
                        onClick={() => toggleStatus(s)}
                        className={cn(
                          "text-xs px-2.5 py-1 rounded-md border transition-colors capitalize",
                          form.filterStatus.includes(s)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border hover:bg-muted"
                        )}
                        data-testid={`filter-status-${s}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  {form.filterStatus.length === 0 && (
                    <div className="text-[10px] text-muted-foreground/60 mt-1">No filter = all statuses included</div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs mb-1 block text-muted-foreground">Min Lead Score</Label>
                    <Input
                      type="number" min={0} max={100}
                      value={form.filterScoreMin}
                      onChange={e => setForm(f => ({ ...f, filterScoreMin: parseInt(e.target.value) || 0 }))}
                      className="h-8 text-sm"
                      data-testid="input-score-min"
                    />
                  </div>
                  <div>
                    <Label className="text-xs mb-1 block text-muted-foreground">Max Lead Score</Label>
                    <Input
                      type="number" min={0} max={100}
                      value={form.filterScoreMax}
                      onChange={e => setForm(f => ({ ...f, filterScoreMax: parseInt(e.target.value) || 100 }))}
                      className="h-8 text-sm"
                      data-testid="input-score-max"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs mb-1 block text-muted-foreground">Interested Model (optional)</Label>
                  <Input
                    placeholder="e.g. Splendor Plus — leave blank for all"
                    value={form.filterModel}
                    onChange={e => setForm(f => ({ ...f, filterModel: e.target.value }))}
                    className="h-8 text-sm"
                    data-testid="input-filter-model"
                  />
                </div>
              </div>

              <Button
                className="w-full text-sm"
                onClick={() => createMutation.mutate(form)}
                disabled={createMutation.isPending || !form.name || !form.messageTemplate}
                data-testid="button-submit-campaign"
              >
                {createMutation.isPending ? "Creating…" : "Create Campaign"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Campaign list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 bg-card border border-card-border rounded-lg animate-pulse" />
          ))}
        </div>
      ) : campaigns && campaigns.length > 0 ? (
        <div className="space-y-3">
          {campaigns.map(c => (
            <div key={c.id} data-testid={`campaign-${c.id}`} className="bg-card border border-card-border rounded-lg p-4 space-y-3">
              {/* Top row */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={cn(
                    "w-8 h-8 rounded-md flex items-center justify-center shrink-0",
                    c.status === "completed" ? "bg-green-500/20" :
                    c.status === "running" ? "bg-blue-500/20" :
                    "bg-muted"
                  )}>
                    <Megaphone size={14} className={
                      c.status === "completed" ? "text-green-400" :
                      c.status === "running" ? "text-blue-400" :
                      "text-muted-foreground"
                    } />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold truncate">{c.name}</span>
                      <CampaignBadge status={c.status} />
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      Created {new Date(c.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                      {c.filterStatus && c.filterStatus.length > 0 && ` · Status: ${c.filterStatus.join(", ")}`}
                      {(c.filterScoreMin > 0 || c.filterScoreMax < 100) && ` · Score: ${c.filterScoreMin}–${c.filterScoreMax}`}
                      {c.filterModel && ` · Model: ${c.filterModel}`}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {(c.status === "draft" || c.status === "failed") && (
                    <>
                      <Button
                        size="sm" variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => handlePreview(c.id)}
                        disabled={previewLoading && previewId === c.id}
                        data-testid={`preview-campaign-${c.id}`}
                      >
                        <Eye size={11} />Preview
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => sendMutation.mutate(c.id)}
                        disabled={sendMutation.isPending}
                        data-testid={`send-campaign-${c.id}`}
                      >
                        <Send size={11} />Send Blast
                      </Button>
                    </>
                  )}
                  {c.status === "running" && (
                    <div className="flex items-center gap-1.5 text-xs text-blue-400 font-medium">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                      Sending…
                    </div>
                  )}
                  <button
                    onClick={() => { if (confirm("Delete this campaign?")) deleteMutation.mutate(c.id); }}
                    className="p-1.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors"
                    data-testid={`delete-campaign-${c.id}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {/* Stats row */}
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-1.5 text-xs">
                  <Users size={11} className="text-muted-foreground" />
                  <span className="text-muted-foreground">Target:</span>
                  <span className="font-medium">{c.targetCount}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <CheckCircle2 size={11} className="text-green-400" />
                  <span className="text-muted-foreground">Sent:</span>
                  <span className="font-medium text-green-400">{c.sentCount}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <XCircle size={11} className="text-red-400" />
                  <span className="text-muted-foreground">Failed:</span>
                  <span className="font-medium text-red-400">{c.failedCount}</span>
                </div>
                {c.targetCount > 0 && c.status === "completed" && (
                  <div className="flex-1">
                    <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                      <div
                        className="bg-green-500 h-1 rounded-full transition-all"
                        style={{ width: `${Math.round((c.sentCount / c.targetCount) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                {c.status === "running" && c.targetCount > 0 && (
                  <div className="flex-1">
                    <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                      <div
                        className="bg-blue-500 h-1 rounded-full transition-all animate-pulse"
                        style={{ width: `${Math.round(((c.sentCount + c.failedCount) / c.targetCount) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Message preview */}
              <div className="bg-muted/30 rounded-md px-3 py-2 text-xs text-muted-foreground font-mono leading-relaxed line-clamp-2 border border-border/50">
                {c.messageTemplate}
              </div>

              {/* Audience preview panel */}
              {previewId === c.id && (
                <div className="border-t border-border pt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold">Target Audience Preview</div>
                    <button onClick={() => { setPreviewId(null); setPreviewData(null); }} className="text-[10px] text-muted-foreground hover:text-foreground">Close</button>
                  </div>
                  {previewLoading ? (
                    <div className="text-xs text-muted-foreground animate-pulse">Loading audience…</div>
                  ) : previewData ? (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-bold text-primary text-lg">{previewData.count}</span>
                        <span className="text-muted-foreground text-xs">leads will receive this message</span>
                        <Button
                          size="sm"
                          className="ml-auto h-7 text-xs gap-1"
                          onClick={() => sendMutation.mutate(c.id)}
                          disabled={sendMutation.isPending || previewData.count === 0}
                          data-testid={`confirm-send-${c.id}`}
                        >
                          <Play size={11} />Confirm & Send
                        </Button>
                      </div>
                      {previewData.leads.length > 0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-thin">
                          {previewData.leads.slice(0, 10).map(l => (
                            <div key={l.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-muted/20">
                              <span className="font-medium">{l.name}</span>
                              <span className="text-muted-foreground">{l.phone}</span>
                              <span className={cn(
                                "ml-auto px-1.5 py-0.5 rounded text-[10px] border",
                                l.score >= 70 ? "text-red-400 border-red-500/30" :
                                l.score >= 40 ? "text-orange-400 border-orange-500/30" :
                                "text-muted-foreground border-border"
                              )}>{l.score}</span>
                            </div>
                          ))}
                          {previewData.count > 10 && (
                            <div className="text-[10px] text-muted-foreground text-center py-1">+ {previewData.count - 10} more</div>
                          )}
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-card border border-card-border rounded-lg py-20 text-center">
          <Megaphone size={36} className="text-muted-foreground/30 mx-auto mb-3" />
          <div className="text-sm text-muted-foreground">No campaigns yet</div>
          <div className="text-xs text-muted-foreground/60 mt-1 max-w-xs mx-auto">
            Create a blast campaign to send WhatsApp messages to a filtered segment of leads — Diwali offers, new model launches, special discounts.
          </div>
        </div>
      )}

      {/* Tips */}
      <div className="bg-card border border-card-border rounded-lg p-4 text-xs text-muted-foreground space-y-1.5">
        <div className="font-medium text-foreground text-sm mb-2">Template Variables</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            { v: "{name}", desc: "Customer's full name" },
            { v: "{phone}", desc: "Customer's phone number" },
            { v: "{model}", desc: "Interested model (or 'Hero bike' if unknown)" },
          ].map(({ v, desc }) => (
            <div key={v} className="flex items-start gap-2">
              <code className="font-mono text-primary shrink-0">{v}</code>
              <span className="text-muted-foreground/70">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
