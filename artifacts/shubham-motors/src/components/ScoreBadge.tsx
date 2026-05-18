import { cn } from "@/lib/utils";

export function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? "bg-red-500/20 text-red-400 border-red-500/30" :
    score >= 60 ? "bg-orange-500/20 text-orange-400 border-orange-500/30" :
    score >= 40 ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" :
    "bg-muted text-muted-foreground border-border";

  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border tabular-nums", color)}>
      {score}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    hot: "bg-red-500/20 text-red-400 border-red-500/30",
    interested: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    converted: "bg-green-500/20 text-green-400 border-green-500/30",
    new: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    contacted: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    followup: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    lost: "bg-muted text-muted-foreground border-border",
    completed: "bg-green-500/20 text-green-400 border-green-500/30",
    pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    cancelled: "bg-muted text-muted-foreground border-border",
    failed: "bg-red-500/20 text-red-400 border-red-500/30",
    in_progress: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    ringing: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    missed: "bg-red-500/20 text-red-400 border-red-500/30",
    initiated: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    transferred: "bg-green-500/20 text-green-400 border-green-500/30",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${map[status] ?? "bg-muted text-muted-foreground border-border"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
