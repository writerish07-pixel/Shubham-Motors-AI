import { useParams, Link } from "wouter";
import { ArrowLeft, Phone, MessageSquare, User } from "lucide-react";
import { useGetCall, getGetCallQueryKey, useTransferCall } from "@workspace/api-client-react";
import { toast } from "sonner";
import { useState } from "react";
import { StatusBadge, ScoreBadge } from "@/components/ScoreBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";

export default function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const callId = parseInt(id ?? "0");
  const [transferNumber, setTransferNumber] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);

  const { data: call, isLoading } = useGetCall(callId, { query: { enabled: !!callId, queryKey: getGetCallQueryKey(callId) } });
  const transferCall = useTransferCall();

  if (isLoading) {
    return <div className="p-6"><div className="h-8 bg-muted rounded animate-pulse w-48" /></div>;
  }
  if (!call) {
    return <div className="p-6 text-muted-foreground">Call not found.</div>;
  }

  function handleTransfer() {
    if (!transferNumber) { toast.error("Enter sales person number"); return; }
    transferCall.mutate({ id: callId, data: { salesPersonNumber: transferNumber } }, {
      onSuccess: (r) => {
        r.success ? toast.success("Call transferred!") : toast.error("Transfer failed");
        setTransferOpen(false);
      },
    });
  }

  const transcriptLines = call.transcript?.split("\n").filter(Boolean) ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/calls">
          <button className="p-1.5 rounded-md hover:bg-muted transition-colors" data-testid="back-to-calls">
            <ArrowLeft size={16} />
          </button>
        </Link>
        <h1 className="text-xl font-bold">Call Detail</h1>
        <StatusBadge status={call.status} />
        {call.scoreAfterCall != null && <ScoreBadge score={call.scoreAfterCall} />}
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Lead", value: call.leadName ?? "Unknown" },
          { label: "Phone", value: call.leadPhone ?? "—" },
          { label: "Direction", value: call.direction },
          { label: "Duration", value: call.duration ? `${call.duration}s` : "—" },
          { label: "Language", value: call.languageDetected ?? "—" },
          { label: "Intent", value: call.intentDetected ?? "—" },
          { label: "WhatsApp", value: call.whatsappSent ? "Sent" : "Not sent" },
          { label: "Transferred To", value: call.transferredTo ?? "—" },
        ].map(({ label, value }) => (
          <div key={label} className="bg-card border border-card-border rounded-lg p-3">
            <div className="text-xs text-muted-foreground mb-1">{label}</div>
            <div className={`text-sm font-medium truncate ${label === "Transferred To" || label === "Phone" ? "" : "capitalize"}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <Link href={`/leads/${call.leadId}`}>
          <Button variant="outline" size="sm" className="gap-1 text-xs" data-testid="view-lead-from-call">
            <User size={12} />View Lead
          </Button>
        </Link>
        {call.status === "in_progress" && (
          <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1 text-xs" data-testid="transfer-call-button">
                <Phone size={12} />Transfer to Sales
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-card-border">
              <DialogHeader><DialogTitle>Transfer Call to Sales Person</DialogTitle></DialogHeader>
              <div className="space-y-3 pt-2">
                <div><Label className="text-xs mb-1 block">Sales Person Number</Label><Input placeholder="10-digit mobile" value={transferNumber} onChange={(e) => setTransferNumber(e.target.value)} data-testid="input-transfer-number" /></div>
                <Button onClick={handleTransfer} disabled={transferCall.isPending} className="w-full text-xs">Transfer Now</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Summary */}
      {call.summary && (
        <div className="bg-card border border-card-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-2">AI Summary</h2>
          <p className="text-sm text-foreground leading-relaxed">{call.summary}</p>
        </div>
      )}

      {/* Transcript */}
      <div className="bg-card border border-card-border rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Transcript</h2>
        {transcriptLines.length > 0 ? (
          <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin pr-1">
            {transcriptLines.map((line, i) => {
              const isAgent = line.startsWith("Agent:");
              const isCustomer = line.startsWith("Customer:");
              return (
                <div key={i} className={`flex gap-2 ${isAgent ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] px-3 py-2 rounded-lg text-xs leading-relaxed ${
                    isAgent ? "bg-primary/20 text-primary-foreground border border-primary/30" :
                    isCustomer ? "bg-muted text-foreground border border-border" :
                    "bg-muted/50 text-muted-foreground"
                  }`}>
                    {line}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground text-sm">No transcript available yet.</div>
        )}
      </div>
    </div>
  );
}
