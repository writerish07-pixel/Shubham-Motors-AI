import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  accent?: boolean;
  trend?: "up" | "down" | "neutral";
  className?: string;
}

export default function StatCard({ label, value, sub, icon, accent, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "bg-card border border-card-border rounded-lg p-4 flex flex-col gap-3",
        accent && "border-primary/40 bg-primary/5",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        {icon && (
          <div className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center",
            accent ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
          )}>
            {icon}
          </div>
        )}
      </div>
      <div>
        <div className={cn("text-2xl font-bold tabular-nums", accent && "text-primary")}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}
