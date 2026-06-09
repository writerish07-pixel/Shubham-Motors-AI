import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Users, Phone, Calendar, BookOpen,
  Settings, Bike, Menu, X, PhoneCall, Megaphone
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/leads", label: "Leads", icon: Users },
  { path: "/calls", label: "Call Logs", icon: Phone },
  { path: "/followups", label: "Follow-ups", icon: Calendar },
  { path: "/campaigns", label: "Campaigns", icon: Megaphone },
  { path: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { path: "/settings", label: "Settings", icon: Settings },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [hasToken, setHasToken] = useState(true);

  useEffect(() => {
    setHasToken(Boolean(localStorage.getItem("shubham_admin_token")));
  }, [location]);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {!hasToken && (
        <div className="fixed top-0 inset-x-0 z-[60] bg-amber-500 text-amber-950 text-center text-sm py-2 px-4">
          API access requires an admin token — set it in{" "}
          <Link href="/settings" className="underline font-semibold">Settings</Link>.
        </div>
      )}
      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-60 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-200",
        mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <Bike size={18} className="text-primary-foreground" />
          </div>
          <div>
            <div className="text-sm font-bold text-sidebar-foreground leading-tight">Shubham Motors</div>
            <div className="text-[10px] text-muted-foreground font-medium tracking-wide uppercase">AI Voice Agent</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto scrollbar-thin">
          {navItems.map(({ path, label, icon: Icon }) => {
            const isActive = path === "/" ? location === "/" : location.startsWith(path);
            return (
              <Link key={path} href={path} onClick={() => setMobileOpen(false)}>
                <div
                  data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium cursor-pointer transition-all duration-150",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <Icon size={16} className="shrink-0" />
                  {label}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Live badge */}
        <div className="px-4 py-4 border-t border-sidebar-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Agent Active
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col md:ml-60 min-w-0">
        {/* Top bar (mobile) */}
        <header className="md:hidden flex items-center gap-3 px-4 h-14 border-b border-border bg-card">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded-md hover:bg-muted"
            data-testid="mobile-menu-button"
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2">
            <PhoneCall size={16} className="text-primary" />
            <span className="text-sm font-semibold">Shubham Motors</span>
          </div>
        </header>

        {/* Page */}
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          {children}
        </main>
      </div>
    </div>
  );
}
