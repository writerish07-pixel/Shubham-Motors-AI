import { ClipboardCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Summary {
  n: number;
  overall: number;
  completeness: number;
  grounding: number;
  booking: number;
  handoff: number;
  talkRatio: number;
  fillerPenalty: number;
}

interface Row {
  id: number;
  callId: number;
  leadId: number;
  overall: number;
  completeness: number;
  grounding: number;
  booking: number;
  handoff: number;
  talkRatio: number;
  fillerPenalty: number;
  notes: string | null;
  createdAt: string;
  leadName: string | null;
  direction: string | null;
  intentDetected: string | null;
}

export default function Shadow() {
  const summaryQ = useQuery<Summary>({
    queryKey: ["shadow-summary"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/shadow/summary`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 30000,
  });
  const rowsQ = useQuery<Row[]>({
    queryKey: ["shadow-rows"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/shadow?limit=50`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 30000,
  });

  const s = summaryQ.data;
  const rows = rowsQ.data ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2"><ClipboardCheck size={20} />Shadow scorecard</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Every completed call is scored vs a human telecaller (no extra LLM). Use this before switching <code className="text-[10px]">REPLACEMENT_MODE</code> from shadow → inbound → full.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Calls scored", s?.n ?? 0],
          ["Overall", s?.overall ?? 0],
          ["Grounding", s?.grounding ?? 0],
          ["Visit close", s?.booking ?? 0],
        ].map(([label, val]) => (
          <div key={String(label)} className="bg-card border border-card-border rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold mt-1">{val}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto border border-card-border rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              {["When", "Lead", "Overall", "Complete", "Ground", "Visit", "Handoff", "Talk", "Filler", "Notes"].map((h) => (
                <th key={h} className="text-left font-medium px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">No scored calls yet — complete a live call after deploy.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-t border-border/60">
                <td className="px-3 py-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                <td className="px-3 py-2">
                  <Link href={`/leads/${r.leadId}`} className="underline">{r.leadName ?? r.leadId}</Link>
                  <div className="text-[10px] text-muted-foreground">{r.direction} · {r.intentDetected ?? "—"}</div>
                </td>
                <td className="px-3 py-2 font-semibold">{r.overall}</td>
                <td className="px-3 py-2">{r.completeness}</td>
                <td className="px-3 py-2">{r.grounding}</td>
                <td className="px-3 py-2">{r.booking}</td>
                <td className="px-3 py-2">{r.handoff}</td>
                <td className="px-3 py-2">{r.talkRatio}</td>
                <td className="px-3 py-2">{r.fillerPenalty}</td>
                <td className="px-3 py-2 text-muted-foreground max-w-[180px] truncate">{r.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
