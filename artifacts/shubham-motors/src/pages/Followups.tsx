import { useState } from "react";
import { Link } from "wouter";
import { Calendar, Play, Trash2, Plus } from "lucide-react";
import {
  useListFollowups, getListFollowupsQueryKey, useExecuteFollowup,
  useDeleteFollowup, useCreateFollowup
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { StatusBadge } from "@/components/ScoreBadge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const STATUSES = ["", "pending", "completed", "cancelled", "failed"];

export default function Followups() {
  const [statusFilter, setStatusFilter] = useState("pending");
  const [showDueOnly, setShowDueOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ leadId: "", scheduledAt: "", reason: "", intentLabel: "" });
  const qc = useQueryClient();

  const { data: followups, isLoading } = useListFollowups(
    { status: statusFilter || undefined, dueToday: showDueOnly || undefined },
    { query: { queryKey: getListFollowupsQueryKey({ status: statusFilter || undefined, dueToday: showDueOnly || undefined }) } }
  );
  const executeFollowup = useExecuteFollowup();
  const deleteFollowup = useDeleteFollowup();
  const createFollowup = useCreateFollowup();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListFollowupsQueryKey() });
  }

  function handleExecute(id: number) {
    executeFollowup.mutate({ id }, {
      onSuccess: (r) => {
        r.success ? toast.success("Follow-up call initiated!") : toast.error("Failed to call");
        invalidate();
      },
    });
  }

  function handleDelete(id: number) {
    if (!confirm("Delete this follow-up?")) return;
    deleteFollowup.mutate({ id }, { onSuccess: () => { toast.success("Deleted"); invalidate(); } });
  }

  function handleCreate() {
    if (!form.leadId || !form.scheduledAt || !form.reason) { toast.error("All fields required"); return; }
    createFollowup.mutate({ data: { leadId: parseInt(form.leadId), scheduledAt: form.scheduledAt, reason: form.reason, intentLabel: form.intentLabel } }, {
      onSuccess: () => { toast.success("Follow-up scheduled"); setAddOpen(false); invalidate(); },
      onError: () => toast.error("Failed"),
    });
  }

  const now = new Date();

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Follow-ups</h1>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2 text-xs" data-testid="add-followup-button"><Plus size={13} />Schedule</Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-card-border">
            <DialogHeader><DialogTitle>Schedule Follow-up</DialogTitle></DialogHeader>
            <div className="space-y-3 pt-2">
              <div><Label className="text-xs mb-1 block">Lead ID *</Label><Input type="number" placeholder="Lead ID" value={form.leadId} onChange={(e) => setForm(f => ({ ...f, leadId: e.target.value }))} /></div>
              <div><Label className="text-xs mb-1 block">Date & Time *</Label><Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm(f => ({ ...f, scheduledAt: e.target.value }))} /></div>
              <div><Label className="text-xs mb-1 block">Reason *</Label><Input placeholder="e.g. Will visit after Diwali" value={form.reason} onChange={(e) => setForm(f => ({ ...f, reason: e.target.value }))} /></div>
              <div><Label className="text-xs mb-1 block">Intent Label</Label><Input placeholder="e.g. future_date, thinking" value={form.intentLabel} onChange={(e) => setForm(f => ({ ...f, intentLabel: e.target.value }))} /></div>
              <Button onClick={handleCreate} disabled={createFollowup.isPending} className="w-full text-xs">Schedule</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36 h-9 text-sm" data-testid="filter-followup-status"><SelectValue placeholder="All Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {STATUSES.filter(Boolean).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <button
          onClick={() => setShowDueOnly(!showDueOnly)}
          className={`text-xs px-3 h-9 rounded-md border transition-colors ${showDueOnly ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
          data-testid="filter-due-today"
        >
          Due Today/Overdue
        </button>
      </div>

      {/* List */}
      <div className="space-y-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 bg-card border border-card-border rounded-lg animate-pulse" />
          ))
        ) : followups && followups.length > 0 ? followups.map((f) => {
          const isOverdue = f.status === "pending" && new Date(f.scheduledAt) < now;
          return (
            <div key={f.id} data-testid={`followup-item-${f.id}`} className={`bg-card border rounded-lg p-4 flex items-center justify-between gap-4 transition-colors ${isOverdue ? "border-red-500/30 bg-red-500/5" : "border-card-border"}`}>
              <div className="flex items-start gap-3 min-w-0">
                <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isOverdue ? "bg-red-500/20" : "bg-muted"}`}>
                  <Calendar size={14} className={isOverdue ? "text-red-400" : "text-muted-foreground"} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/leads/${f.leadId}`}>
                      <span className="text-sm font-medium hover:text-primary cursor-pointer transition-colors">{f.leadName ?? `Lead #${f.leadId}`}</span>
                    </Link>
                    {f.leadPhone && <span className="text-xs text-muted-foreground">{f.leadPhone}</span>}
                    {isOverdue && <span className="text-xs text-red-400 font-medium">OVERDUE</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{f.reason}</div>
                  {f.intentLabel && <div className="text-[10px] text-muted-foreground/70 mt-0.5">Intent: {f.intentLabel}</div>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right hidden sm:block">
                  <div className="text-xs font-medium">{new Date(f.scheduledAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</div>
                  <div className="text-[10px] text-muted-foreground">{new Date(f.scheduledAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}</div>
                </div>
                <StatusBadge status={f.status} />
                {f.status === "pending" && (
                  <button onClick={() => handleExecute(f.id)} className="p-1.5 rounded hover:bg-primary/20 hover:text-primary transition-colors" title="Call now" data-testid={`execute-followup-${f.id}`}>
                    <Play size={13} />
                  </button>
                )}
                <button onClick={() => handleDelete(f.id)} className="p-1.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors" title="Delete" data-testid={`delete-followup-${f.id}`}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        }) : (
          <div className="bg-card border border-card-border rounded-lg py-16 text-center text-muted-foreground text-sm">
            No follow-ups scheduled. The AI agent will auto-schedule them based on call intent.
          </div>
        )}
      </div>
    </div>
  );
}
