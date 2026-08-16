import { Swords } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Row {
  name: string;
  count: number;
  percentage: number;
  topReason: string | null;
}

export default function Competitor() {
  const q = useQuery<Row[]>({
    queryKey: ["competitor-breakdown"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/analytics/competitor-breakdown`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 30000,
  });
  const rows = q.data ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2"><Swords size={20} />Competitor intel</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Brands customers named on calls, with the reason they considered them. Use this in the weekly GM huddle.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No competitor mentions yet.</div>
      ) : (
        <div className="bg-card border border-card-border rounded-lg divide-y divide-border">
          {rows.map((row) => (
            <div key={row.name} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-sm font-medium">{row.name}</div>
                <div className="text-xs text-muted-foreground">{row.topReason ?? "reason not captured"}</div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold tabular-nums">{row.count}</div>
                <div className="text-[10px] text-muted-foreground">{row.percentage}%</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <Link href="/" className="text-xs text-primary hover:underline">Back to dashboard</Link>
    </div>
  );
}
