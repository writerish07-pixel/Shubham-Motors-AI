import { useState } from "react";
import { Link } from "wouter";
import { Phone, PhoneIncoming, PhoneOutgoing, MessageSquare, ChevronRight } from "lucide-react";
import { useListCalls, getListCallsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { StatusBadge, ScoreBadge } from "@/components/ScoreBadge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const STATUSES = ["", "initiated", "in_progress", "completed", "missed", "failed", "transferred"];

export default function Calls() {
  const [statusFilter, setStatusFilter] = useState("");
  const qc = useQueryClient();
  const { data: calls, isLoading } = useListCalls({ status: statusFilter || undefined });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Call Logs</h1>
        <div className="flex items-center gap-2">
          <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="w-36 h-9 text-sm" data-testid="filter-call-status"><SelectValue placeholder="All Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              {STATUSES.filter(Boolean).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: getListCallsQueryKey() })} className="h-9 px-3 text-xs">Refresh</Button>
        </div>
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Lead</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Direction</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Duration</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Language</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell">Score After</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell">WhatsApp</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden xl:table-cell">Summary</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={10} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse w-full" /></td></tr>
                ))
              ) : calls && calls.length > 0 ? calls.map((call) => (
                <tr key={call.id} data-testid={`call-row-${call.id}`} className="hover:bg-muted/30 transition-colors group">
                  <td className="px-4 py-3">
                    <div className="font-medium">{call.leadName ?? "Unknown"}</div>
                    <div className="text-xs text-muted-foreground">{call.leadPhone}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {call.direction === "inbound"
                        ? <PhoneIncoming size={13} className="text-green-400" />
                        : <PhoneOutgoing size={13} className="text-blue-400" />}
                      <span className="text-xs capitalize">{call.direction}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={call.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{call.duration ? `${call.duration}s` : "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{call.languageDetected ?? "—"}</td>
                  <td className="px-4 py-3 hidden lg:table-cell">{call.scoreAfterCall != null ? <ScoreBadge score={call.scoreAfterCall} /> : "—"}</td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {call.whatsappSent
                      ? <span className="flex items-center gap-1 text-green-400 text-xs"><MessageSquare size={12} />Sent</span>
                      : <span className="text-muted-foreground text-xs">No</span>}
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell">
                    <div className="text-xs text-muted-foreground max-w-[200px] truncate">{call.summary ?? "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(call.createdAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/calls/${call.id}`}>
                      <button className="p-1.5 rounded hover:bg-muted transition-colors" data-testid={`view-call-${call.id}`}>
                        <ChevronRight size={13} />
                      </button>
                    </Link>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-muted-foreground text-sm">No calls recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {calls && <div className="text-xs text-muted-foreground">{calls.length} call{calls.length !== 1 ? "s" : ""}</div>}
    </div>
  );
}
