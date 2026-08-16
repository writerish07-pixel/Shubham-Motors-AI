import { useState } from "react";
import { Users, Phone, TrendingUp, Calendar, Star, MessageSquare, PhoneCall, ArrowUpRight, Play, Square, Clock, CheckCircle2, XCircle, AlertCircle, RefreshCw, Settings2 } from "lucide-react";
import { Link } from "wouter";
import {
  useGetDashboardStats, useGetHotLeads, useGetRecentActivity,
  useGetLeadFunnel, useGetCallPerformance
} from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie
} from "recharts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import StatCard from "@/components/StatCard";
import { ScoreBadge, StatusBadge } from "@/components/ScoreBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6"];

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchSchedulerStatus() {
  const r = await fetch(`${BASE}/api/scheduler/status`);
  return r.json();
}

async function triggerManualRun() {
  const r = await fetch(`${BASE}/api/scheduler/run`, { method: "POST" });
  return r.json();
}

async function patchSchedulerConfig(body: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/scheduler/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function postSchedulerAction(action: "start" | "stop") {
  const r = await fetch(`${BASE}/api/scheduler/${action}`, { method: "POST" });
  return r.json();
}

export default function Dashboard() {
  const qc = useQueryClient();
  const [showSchedulerConfig, setShowSchedulerConfig] = useState(false);
  const [cronInput, setCronInput] = useState("");
  const [maxCalls, setMaxCalls] = useState("");
  const [delayMs, setDelayMs] = useState("");

  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: hotLeads } = useGetHotLeads();
  const { data: activity } = useGetRecentActivity();
  const { data: funnel } = useGetLeadFunnel();
  const { data: callPerf } = useGetCallPerformance({ days: 7 });
  const scorecardQ = useQuery({
    queryKey: ["employee-scorecard"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/analytics/employee-scorecard`);
      if (!r.ok) throw new Error("failed");
      return r.json() as Promise<{
        visitsBooked: number; financeTransfers: number; followupsDone: number;
        followupsOverdue: number; shadowQuality: number; competitorMentions: number;
        openRevenue: number; avgRelationship: number; avgCsat: number;
        silentGreetings: number; avgTurnMs: number;
      }>;
    },
    refetchInterval: 30000,
  });
  const sc = scorecardQ.data;

  const { data: scheduler, isLoading: schedLoading } = useQuery({
    queryKey: ["scheduler-status"],
    queryFn: fetchSchedulerStatus,
    refetchInterval: 5000,
  });

  const runMutation = useMutation({
    mutationFn: triggerManualRun,
    onSuccess: () => {
      toast.success("Auto-dialer triggered — calling all due follow-ups");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["scheduler-status"] }), 2000);
    },
    onError: () => toast.error("Failed to trigger auto-dialer"),
  });

  const configMutation = useMutation({
    mutationFn: patchSchedulerConfig,
    onSuccess: () => {
      toast.success("Scheduler config updated");
      qc.invalidateQueries({ queryKey: ["scheduler-status"] });
      setShowSchedulerConfig(false);
    },
  });

  const actionMutation = useMutation({
    mutationFn: postSchedulerAction,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduler-status"] }),
  });

  function saveConfig() {
    const updates: Record<string, unknown> = {};
    if (cronInput) updates.cronExpression = cronInput;
    if (maxCalls) updates.maxCallsPerRun = parseInt(maxCalls);
    if (delayMs) updates.delayBetweenCallsMs = parseInt(delayMs);
    configMutation.mutate(updates);
  }

  const isRunning = scheduler?.running;
  const lastResult = scheduler?.lastRunResult;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Command Center</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Shubham Motors — Hero MotoCorp</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-muted-foreground font-medium">Agent Live</span>
        </div>
      </div>

      {/* Auto-dialer Banner */}
      <div className={cn(
        "rounded-lg border p-4 transition-colors",
        isRunning
          ? "bg-primary/10 border-primary/40"
          : "bg-card border-card-border"
      )}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
              isRunning ? "bg-primary/20" : "bg-muted"
            )}>
              <Phone size={18} className={isRunning ? "text-primary animate-pulse" : "text-muted-foreground"} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">Auto-Dialer</span>
                {isRunning ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 font-medium animate-pulse">RUNNING</span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border font-medium">IDLE</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                {schedLoading ? "Loading…" : (
                  <>
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      Next run: {scheduler?.nextRun ? new Date(scheduler.nextRun).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "—"}
                    </span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>Schedule: <code className="font-mono text-[10px]">{scheduler?.config?.cronExpression ?? "0 9 * * *"}</code></span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>Max {scheduler?.config?.maxCallsPerRun ?? 50} calls/run</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Last run stats */}
            {lastResult && (
              <div className="flex items-center gap-3 text-xs border border-border rounded-md px-3 py-1.5 bg-muted/40 hidden sm:flex">
                <span className="flex items-center gap-1 text-green-400"><CheckCircle2 size={11} />{lastResult.succeeded} ok</span>
                <span className="flex items-center gap-1 text-red-400"><XCircle size={11} />{lastResult.failed} failed</span>
                <span className="flex items-center gap-1 text-muted-foreground"><AlertCircle size={11} />{lastResult.skipped} skipped</span>
              </div>
            )}

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowSchedulerConfig(!showSchedulerConfig)}
              className="h-8 w-8 p-0"
              data-testid="scheduler-config-toggle"
              title="Configure"
            >
              <Settings2 size={14} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => qc.invalidateQueries({ queryKey: ["scheduler-status"] })}
              className="h-8 w-8 p-0"
              title="Refresh status"
            >
              <RefreshCw size={13} />
            </Button>

            {scheduler?.config && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => actionMutation.mutate(cronInput ? "start" : "stop")}
                className="h-8 text-xs gap-1.5"
                data-testid="scheduler-toggle-button"
                disabled={actionMutation.isPending}
              >
                {isRunning ? <><Square size={11} />Stop</>  : <><Play size={11} />Start</>}
              </Button>
            )}

            <Button
              size="sm"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending || isRunning}
              className="h-8 text-xs gap-1.5"
              data-testid="scheduler-run-now-button"
            >
              <Play size={11} />
              {isRunning ? "Running…" : "Run Now"}
            </Button>
          </div>
        </div>

        {/* Config panel */}
        {showSchedulerConfig && (
          <div className="mt-4 pt-4 border-t border-border grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs mb-1 block text-muted-foreground">Cron Expression</Label>
              <Input
                placeholder={scheduler?.config?.cronExpression ?? "0 9 * * *"}
                value={cronInput}
                onChange={(e) => setCronInput(e.target.value)}
                className="text-xs h-8 font-mono"
                data-testid="input-cron-expression"
              />
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">e.g. 0 9 * * * = 9 AM daily</div>
            </div>
            <div>
              <Label className="text-xs mb-1 block text-muted-foreground">Max Calls per Run</Label>
              <Input
                type="number"
                placeholder={String(scheduler?.config?.maxCallsPerRun ?? 50)}
                value={maxCalls}
                onChange={(e) => setMaxCalls(e.target.value)}
                className="text-xs h-8"
                data-testid="input-max-calls"
              />
            </div>
            <div>
              <Label className="text-xs mb-1 block text-muted-foreground">Delay Between Calls (ms)</Label>
              <Input
                type="number"
                placeholder={String(scheduler?.config?.delayBetweenCallsMs ?? 5000)}
                value={delayMs}
                onChange={(e) => setDelayMs(e.target.value)}
                className="text-xs h-8"
                data-testid="input-delay-ms"
              />
            </div>
            <div className="sm:col-span-3 flex gap-2">
              <Button size="sm" className="text-xs h-8" onClick={saveConfig} disabled={configMutation.isPending} data-testid="save-scheduler-config">
                Save Config
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-8" onClick={() => setShowSchedulerConfig(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Last run detail */}
        {lastResult && lastResult.details && lastResult.details.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Last run — {scheduler?.lastRun ? new Date(scheduler.lastRun).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : ""}
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto scrollbar-thin">
              {lastResult.details.map((d: { followupId: number; leadName: string; phone: string; success: boolean; reason: string }, i: number) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {d.success
                    ? <CheckCircle2 size={11} className="text-green-400 shrink-0" />
                    : <XCircle size={11} className="text-red-400 shrink-0" />}
                  <span className="font-medium">{d.leadName}</span>
                  <span className="text-muted-foreground">{d.phone}</span>
                  <span className={cn("text-muted-foreground/70 truncate", !d.success && "text-red-400/70")}>{d.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Leads" value={statsLoading ? "—" : (stats?.totalLeads ?? 0)} icon={<Users size={14} />} sub="All time" />
        <StatCard label="Hot Leads" value={statsLoading ? "—" : (stats?.hotLeads ?? 0)} icon={<Star size={14} />} accent sub="Ready to buy" />
        <StatCard label="Calls Today" value={statsLoading ? "—" : (stats?.callsToday ?? 0)} icon={<Phone size={14} />} sub={`${stats?.totalCalls ?? 0} total`} />
        <StatCard label="Conversion Rate" value={statsLoading ? "—" : `${stats?.conversionRate ?? 0}%`} icon={<TrendingUp size={14} />} sub="Leads to sales" />
        <StatCard label="Follow-ups Due" value={statsLoading ? "—" : (stats?.followupsDue ?? 0)} icon={<Calendar size={14} />} sub="Overdue or today" />
        <StatCard label="Avg Lead Score" value={statsLoading ? "—" : (stats?.avgLeadScore ?? 0)} icon={<TrendingUp size={14} />} sub="Out of 100" />
        <StatCard label="WhatsApp Sent" value={statsLoading ? "—" : (stats?.whatsappSent ?? 0)} icon={<MessageSquare size={14} />} sub="Post-call summaries" />
        <StatCard label="Total Calls" value={statsLoading ? "—" : (stats?.totalCalls ?? 0)} icon={<PhoneCall size={14} />} sub="Inbound + outbound" />
      </div>

      <div className="bg-card border border-card-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Sakshi employee scorecard</h2>
          <Link href="/competitor"><span className="text-xs text-primary hover:underline cursor-pointer">Competitor intel</span></Link>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Visits booked" value={sc?.visitsBooked ?? "—"} icon={<Calendar size={14} />} sub="Showroom / test ride" />
          <StatCard label="Finance handoffs" value={sc?.financeTransfers ?? "—"} icon={<Phone size={14} />} sub="Transferred to finance" />
          <StatCard label="Follow-ups done" value={sc?.followupsDone ?? "—"} icon={<CheckCircle2 size={14} />} sub={`${sc?.followupsOverdue ?? 0} overdue`} />
          <StatCard label="Call quality" value={sc?.shadowQuality ?? "—"} icon={<Star size={14} />} sub="Shadow overall" />
          <StatCard label="Open revenue" value={sc ? `₹${Number(sc.openRevenue).toLocaleString("en-IN")}` : "—"} icon={<TrendingUp size={14} />} sub="Probability-weighted" />
          <StatCard label="Relationship" value={sc?.avgRelationship ?? "—"} icon={<Users size={14} />} sub="Avg score" />
          <StatCard label="CSAT" value={sc?.avgCsat ?? "—"} icon={<MessageSquare size={14} />} sub="1–5 after visit" />
          <StatCard label="Silent pickups" value={sc?.silentGreetings ?? "—"} icon={<AlertCircle size={14} />} sub={sc?.avgTurnMs ? `${sc.avgTurnMs} ms avg turn` : "Greeting fail"} />
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-card-border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-foreground mb-4">Call Performance (Last 7 Days)</h2>
          {callPerf && callPerf.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={callPerf} barGap={2}>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }} labelStyle={{ color: "hsl(var(--foreground))" }} />
                <Bar dataKey="totalCalls" name="Total" fill="hsl(var(--chart-4))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="completed" name="Completed" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="transferred" name="Transferred" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">No call data yet</div>
          )}
        </div>

        <div className="bg-card border border-card-border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-foreground mb-4">Lead Funnel</h2>
          {funnel && funnel.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={funnel} dataKey="count" nameKey="stage" cx="50%" cy="50%" outerRadius={70} label={({ stage, percentage }) => `${stage} ${percentage}%`} labelLine={false}>
                  {funnel.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">No leads yet</div>
          )}
        </div>
      </div>

      {/* Hot leads + Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-card-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Hot Leads</h2>
            <Link href="/leads"><span className="text-xs text-primary hover:underline cursor-pointer flex items-center gap-1">View all <ArrowUpRight size={12} /></span></Link>
          </div>
          {hotLeads && hotLeads.length > 0 ? (
            <div className="space-y-2">
              {hotLeads.slice(0, 6).map((lead) => (
                <Link key={lead.id} href={`/leads/${lead.id}`}>
                  <div data-testid={`hot-lead-${lead.id}`} className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/50 cursor-pointer transition-colors group">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{lead.name}</div>
                      <div className="text-xs text-muted-foreground">{lead.phone}{lead.interestedModel && ` • ${lead.interestedModel}`}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <ScoreBadge score={lead.score} />
                      <StatusBadge status={lead.status} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground text-sm">No hot leads yet. Start calling!</div>
          )}
        </div>

        <div className="bg-card border border-card-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Recent Activity</h2>
          {activity && activity.length > 0 ? (
            <div className="space-y-2">
              {activity.slice(0, 8).map((item) => (
                <div key={item.id} data-testid={`activity-${item.id}`} className="flex items-start gap-3 py-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                    item.type === "call_transferred" ? "bg-green-500" :
                    item.type === "call_missed" ? "bg-red-500" :
                    item.type === "lead_scored_hot" ? "bg-red-500 animate-pulse" :
                    item.type === "whatsapp_sent" ? "bg-green-400" :
                    "bg-blue-400"
                  }`} />
                  <div className="min-w-0">
                    <div className="text-xs text-foreground">{item.description}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(item.createdAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground text-sm">No activity yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
