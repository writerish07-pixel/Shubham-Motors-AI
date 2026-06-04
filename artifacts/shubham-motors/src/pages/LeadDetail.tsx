import { useParams, Link } from "wouter";
import { ArrowLeft, Phone, Calendar, MessageSquare, Edit2, Save, X } from "lucide-react";
import { useState } from "react";
import {
  useGetLead, getGetLeadQueryKey, useListCalls, getListCallsQueryKey,
  useListFollowups, getListFollowupsQueryKey, useUpdateLead, useTriggerOutboundCall, useCreateFollowup
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScoreBadge, StatusBadge } from "@/components/ScoreBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const leadId = parseInt(id ?? "0");
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [showFollowupForm, setShowFollowupForm] = useState(false);
  const [followupData, setFollowupData] = useState({ scheduledAt: "", reason: "" });

  const { data: lead, isLoading } = useGetLead(leadId, { query: { enabled: !!leadId, queryKey: getGetLeadQueryKey(leadId) } });
  const { data: calls } = useListCalls({ leadId }, { query: { enabled: !!leadId, queryKey: getListCallsQueryKey({ leadId }) } });
  const { data: followups } = useListFollowups({}, { query: { queryKey: getListFollowupsQueryKey({}) } });
  const updateLead = useUpdateLead();
  const triggerCall = useTriggerOutboundCall();
  const createFollowup = useCreateFollowup();

  const leadFollowups = followups?.filter((f) => f.leadId === leadId) ?? [];

  if (isLoading) {
    return <div className="p-6"><div className="h-8 bg-muted rounded animate-pulse w-48" /></div>;
  }
  if (!lead) {
    return <div className="p-6 text-muted-foreground">Lead not found.</div>;
  }

  function startEdit() {
    setEditForm({ name: lead!.name, phone: lead!.phone, email: lead!.email ?? "", interestedModel: lead!.interestedModel ?? "", notes: lead!.notes ?? "" });
    setEditing(true);
  }

  function saveEdit() {
    updateLead.mutate({ id: leadId, data: editForm }, {
      onSuccess: () => {
        toast.success("Lead updated");
        setEditing(false);
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      },
      onError: () => toast.error("Update failed"),
    });
  }

  function handleCall() {
    triggerCall.mutate({ id: leadId }, {
      onSuccess: (r) => r.success ? toast.success("Calling...") : toast.error("Call failed"),
    });
  }

  function handleScheduleFollowup() {
    if (!followupData.scheduledAt || !followupData.reason) { toast.error("Fill all fields"); return; }
    createFollowup.mutate({ data: { leadId, ...followupData } }, {
      onSuccess: () => {
        toast.success("Follow-up scheduled");
        setShowFollowupForm(false);
        qc.invalidateQueries({ queryKey: getListFollowupsQueryKey({}) });
      },
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/leads">
          <button className="p-1.5 rounded-md hover:bg-muted transition-colors" data-testid="back-to-leads">
            <ArrowLeft size={16} />
          </button>
        </Link>
        <h1 className="text-xl font-bold truncate">{lead.name}</h1>
        <StatusBadge status={lead.status} />
        <ScoreBadge score={lead.score} />
        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" onClick={saveEdit} disabled={updateLead.isPending} className="gap-1 text-xs"><Save size={12} />Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="gap-1 text-xs"><X size={12} />Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={startEdit} className="gap-1 text-xs" data-testid="edit-lead-button"><Edit2 size={12} />Edit</Button>
          )}
          <Button size="sm" onClick={handleCall} className="gap-1 text-xs" data-testid="call-lead-detail-button"><Phone size={12} />Call Now</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Profile */}
        <div className="md:col-span-2 bg-card border border-card-border rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-semibold">Lead Profile</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Name", key: "name" },
              { label: "Phone", key: "phone" },
              { label: "Email", key: "email" },
              { label: "Interested Model", key: "interestedModel" },
            ].map(({ label, key }) => (
              <div key={key}>
                <Label className="text-xs text-muted-foreground mb-1 block">{label}</Label>
                {editing ? (
                  <Input value={editForm[key] ?? ""} onChange={(e) => setEditForm(f => ({ ...f, [key]: e.target.value }))} className="h-8 text-sm" />
                ) : (
                  <div className="text-sm text-foreground">{(lead as unknown as Record<string, unknown>)[key] as string || "—"}</div>
                )}
              </div>
            ))}
          </div>
          {lead.intentSummary && (
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Intent Summary</Label>
              <div className="text-sm text-foreground bg-muted/30 rounded-md p-2">{lead.intentSummary}</div>
            </div>
          )}
          {lead.notes && !editing && (
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Notes</Label>
              <div className="text-sm text-muted-foreground">{lead.notes}</div>
            </div>
          )}
          {editing && (
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Notes</Label>
              <Input value={editForm["notes"] ?? ""} onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value }))} className="text-sm" />
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="space-y-3">
          <div className="bg-card border border-card-border rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-1">Lead Score</div>
            <div className="text-3xl font-bold tabular-nums text-primary">{lead.score}</div>
            <div className="w-full bg-muted rounded-full h-1.5 mt-2">
              <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${lead.score}%` }} />
            </div>
          </div>
          <div className="bg-card border border-card-border rounded-lg p-4 space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground text-xs">Source</span><span>{lead.source ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground text-xs">Language</span><span>{lead.language ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground text-xs">Next Follow-up</span><span>{lead.nextFollowupAt ? new Date(lead.nextFollowupAt).toLocaleDateString("en-IN") : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground text-xs">Created</span><span>{new Date(lead.createdAt).toLocaleDateString("en-IN")}</span></div>
          </div>

          {/* CRM Intelligence — populated by Sakshi from calls */}
          {((lead as any).dailyKm || (lead as any).budget || (lead as any).familyInfo || (lead as any).currentVehicle || (lead as any).competitorMentioned || (lead as any).buyingTimeline || (lead as any).occupation) && (
            <div className="bg-card border border-card-border rounded-lg p-4 space-y-2 text-sm">
              <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">What Sakshi Learned</div>
              {(lead as any).dailyKm && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Daily km</span><span>{(lead as any).dailyKm} km/day</span></div>}
              {(lead as any).budget && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Budget</span><span>₹{((lead as any).budget as number).toLocaleString("en-IN")}</span></div>}
              {(lead as any).currentVehicle && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Current vehicle</span><span>{(lead as any).currentVehicle}</span></div>}
              {(lead as any).occupation && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Occupation</span><span>{(lead as any).occupation}</span></div>}
              {(lead as any).buyingTimeline && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Timeline</span><span className="capitalize">{(lead as any).buyingTimeline}</span></div>}
              {(lead as any).competitorMentioned && (
                <div className="pt-1 border-t border-border">
                  <div className="text-muted-foreground text-xs mb-1">Comparing with</div>
                  <div className="text-sm font-medium">{(lead as any).competitorMentioned}</div>
                  {(lead as any).competitorReason && <div className="text-xs text-muted-foreground">Reason: {(lead as any).competitorReason}</div>}
                </div>
              )}
              {(lead as any).familyInfo && (
                <div className="pt-1 border-t border-border">
                  <div className="text-muted-foreground text-xs mb-1">Family info</div>
                  <div className="text-xs text-foreground">{(lead as any).familyInfo}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Call history */}
      <div className="bg-card border border-card-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Call History</h2>
        {calls && calls.length > 0 ? (
          <div className="space-y-2">
            {calls.map((call) => (
              <Link key={call.id} href={`/calls/${call.id}`}>
                <div data-testid={`call-history-${call.id}`} className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/50 cursor-pointer transition-colors">
                  <div>
                    <div className="text-sm font-medium capitalize">{call.direction} call</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{call.summary ?? "No summary yet"}</div>
                  </div>
                  <div className="flex items-center gap-2 text-right shrink-0">
                    <StatusBadge status={call.status} />
                    <div className="text-xs text-muted-foreground">{call.duration ? `${call.duration}s` : ""}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="py-4 text-center text-muted-foreground text-sm">No calls yet</div>
        )}
      </div>

      {/* Follow-ups */}
      <div className="bg-card border border-card-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Follow-ups</h2>
          <Button size="sm" variant="outline" onClick={() => setShowFollowupForm(!showFollowupForm)} className="text-xs gap-1">
            <Calendar size={12} /> Schedule
          </Button>
        </div>
        {showFollowupForm && (
          <div className="bg-muted/30 rounded-md p-3 mb-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs mb-1 block">Date & Time</Label><Input type="datetime-local" value={followupData.scheduledAt} onChange={(e) => setFollowupData(f => ({ ...f, scheduledAt: e.target.value }))} className="text-sm h-8" /></div>
              <div><Label className="text-xs mb-1 block">Reason</Label><Input placeholder="Why follow up?" value={followupData.reason} onChange={(e) => setFollowupData(f => ({ ...f, reason: e.target.value }))} className="text-sm h-8" /></div>
            </div>
            <Button size="sm" onClick={handleScheduleFollowup} disabled={createFollowup.isPending} className="text-xs">Save</Button>
          </div>
        )}
        {leadFollowups.length > 0 ? (
          <div className="space-y-2">
            {leadFollowups.map((f) => (
              <div key={f.id} data-testid={`followup-${f.id}`} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/20">
                <div>
                  <div className="text-sm">{f.reason}</div>
                  <div className="text-xs text-muted-foreground">{new Date(f.scheduledAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                </div>
                <StatusBadge status={f.status} />
              </div>
            ))}
          </div>
        ) : (
          <div className="py-4 text-center text-muted-foreground text-sm">No follow-ups scheduled</div>
        )}
      </div>
    </div>
  );
}
