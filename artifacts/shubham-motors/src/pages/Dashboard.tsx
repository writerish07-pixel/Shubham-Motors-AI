import { Users, Phone, TrendingUp, Calendar, Star, MessageSquare, PhoneCall, ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import {
  useGetDashboardStats, useGetHotLeads, useGetRecentActivity,
  useGetLeadFunnel, useGetCallPerformance
} from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend
} from "recharts";
import StatCard from "@/components/StatCard";
import { ScoreBadge, StatusBadge } from "@/components/ScoreBadge";

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6"];

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: hotLeads } = useGetHotLeads();
  const { data: activity } = useGetRecentActivity();
  const { data: funnel } = useGetLeadFunnel();
  const { data: callPerf } = useGetCallPerformance({ days: 7 });

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

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Leads"
          value={statsLoading ? "—" : (stats?.totalLeads ?? 0)}
          icon={<Users size={14} />}
          sub="All time"
        />
        <StatCard
          label="Hot Leads"
          value={statsLoading ? "—" : (stats?.hotLeads ?? 0)}
          icon={<Star size={14} />}
          accent
          sub="Ready to buy"
        />
        <StatCard
          label="Calls Today"
          value={statsLoading ? "—" : (stats?.callsToday ?? 0)}
          icon={<Phone size={14} />}
          sub={`${stats?.totalCalls ?? 0} total`}
        />
        <StatCard
          label="Conversion Rate"
          value={statsLoading ? "—" : `${stats?.conversionRate ?? 0}%`}
          icon={<TrendingUp size={14} />}
          sub="Leads to sales"
        />
        <StatCard
          label="Follow-ups Due"
          value={statsLoading ? "—" : (stats?.followupsDue ?? 0)}
          icon={<Calendar size={14} />}
          sub="Overdue or today"
        />
        <StatCard
          label="Avg Lead Score"
          value={statsLoading ? "—" : (stats?.avgLeadScore ?? 0)}
          icon={<TrendingUp size={14} />}
          sub="Out of 100"
        />
        <StatCard
          label="WhatsApp Sent"
          value={statsLoading ? "—" : (stats?.whatsappSent ?? 0)}
          icon={<MessageSquare size={14} />}
          sub="Post-call summaries"
        />
        <StatCard
          label="Total Calls"
          value={statsLoading ? "—" : (stats?.totalCalls ?? 0)}
          icon={<PhoneCall size={14} />}
          sub="Inbound + outbound"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Call Performance */}
        <div className="bg-card border border-card-border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-foreground mb-4">Call Performance (Last 7 Days)</h2>
          {callPerf && callPerf.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={callPerf} barGap={2}>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "hsl(var(--foreground))" }}
                />
                <Bar dataKey="totalCalls" name="Total" fill="hsl(var(--chart-4))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="completed" name="Completed" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="transferred" name="Transferred" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">No call data yet</div>
          )}
        </div>

        {/* Lead Funnel */}
        <div className="bg-card border border-card-border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-foreground mb-4">Lead Funnel</h2>
          {funnel && funnel.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={funnel} dataKey="count" nameKey="stage" cx="50%" cy="50%" outerRadius={70} label={({ stage, percentage }) => `${stage} ${percentage}%`} labelLine={false}>
                  {funnel.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">No leads yet</div>
          )}
        </div>
      </div>

      {/* Hot leads + Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Hot Leads */}
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
                      <div className="text-xs text-muted-foreground">{lead.phone} {lead.interestedModel && `• ${lead.interestedModel}`}</div>
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

        {/* Recent Activity */}
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
