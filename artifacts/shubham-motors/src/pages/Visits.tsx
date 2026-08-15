import { useState } from "react";
import { CalendarClock, Plus, Trash2, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function adminHeaders(json = false): HeadersInit {
  const t = localStorage.getItem("shubham_admin_token") ?? "";
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(t ? { "X-Admin-Token": t } : {}),
  };
}

async function api(path: string, opts?: RequestInit) {
  const r = await fetch(`${BASE}/api${path}`, opts);
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null;
  return r.json();
}

function istLabel(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

interface Slot {
  id: number;
  startsAt: string;
  capacity: number;
  bookedCount: number;
  label: string | null;
  isActive: boolean;
}

interface Booking {
  id: number;
  status: string;
  startsAt: string | null;
  leadId: number;
  leadName: string | null;
  leadPhone: string | null;
  interestedModel: string | null;
}

export default function Visits() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [capacity, setCapacity] = useState("1");

  const slotsQ = useQuery<Slot[]>({
    queryKey: ["visit-slots"],
    queryFn: () => api("/visits/slots"),
    refetchInterval: 30000,
  });
  const bookingsQ = useQuery<Booking[]>({
    queryKey: ["visit-bookings"],
    queryFn: () => api("/visits/bookings"),
    refetchInterval: 30000,
  });

  const generate = useMutation({
    mutationFn: () => api("/visits/generate-week", { method: "POST", headers: adminHeaders(true), body: JSON.stringify({ times: ["11:00", "16:00"], weekdays: [1, 2, 3, 4, 5, 6] }) }),
    onSuccess: (r) => { toast.success(`Created ${r.created} slots (Mon–Sat 11am & 4pm IST)`); qc.invalidateQueries({ queryKey: ["visit-slots"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const createSlot = useMutation({
    mutationFn: () => api("/visits/slots", { method: "POST", headers: adminHeaders(true), body: JSON.stringify({ startsAt: new Date(startsAt).toISOString(), capacity: Number(capacity) || 1 }) }),
    onSuccess: () => { toast.success("Slot added"); setAddOpen(false); qc.invalidateQueries({ queryKey: ["visit-slots"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeSlot = useMutation({
    mutationFn: (id: number) => api(`/visits/slots/${id}`, { method: "DELETE", headers: adminHeaders() }),
    onSuccess: () => { toast.success("Slot removed"); qc.invalidateQueries({ queryKey: ["visit-slots"] }); },
  });

  const cancelBooking = useMutation({
    mutationFn: (id: number) => api(`/visits/bookings/${id}/cancel`, { method: "POST", headers: adminHeaders(true), body: "{}" }),
    onSuccess: () => { toast.success("Booking cancelled"); qc.invalidateQueries({ queryKey: ["visit-bookings"] }); qc.invalidateQueries({ queryKey: ["visit-slots"] }); },
  });

  const slots = slotsQ.data ?? [];
  const bookings = bookingsQ.data ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><CalendarClock size={20} />Showroom visits</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Sakshi books these slots on the call. Generate a two-week grid or add one time.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => generate.mutate()} disabled={generate.isPending}>
            <Sparkles size={14} className="mr-1" /> Generate Mon–Sat
          </Button>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus size={14} className="mr-1" /> Add slot</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New visit slot</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Starts at (local)</Label>
                  <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Capacity</Label>
                  <Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
                </div>
                <Button className="w-full" onClick={() => createSlot.mutate()} disabled={!startsAt || createSlot.isPending}>Save</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Open slots</h2>
          {slots.length === 0 ? (
            <div className="text-xs text-muted-foreground border border-dashed rounded-lg p-6 text-center">No slots yet — generate a week.</div>
          ) : slots.map((s) => (
            <div key={s.id} className="bg-card border border-card-border rounded-lg px-3 py-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{istLabel(s.startsAt)}</div>
                <div className="text-[11px] text-muted-foreground">{s.bookedCount}/{s.capacity} booked{s.label ? ` · ${s.label}` : ""}</div>
              </div>
              <button onClick={() => removeSlot.mutate(s.id)} className="p-1.5 rounded hover:bg-destructive/20 hover:text-destructive"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Bookings</h2>
          {bookings.length === 0 ? (
            <div className="text-xs text-muted-foreground border border-dashed rounded-lg p-6 text-center">No bookings yet.</div>
          ) : bookings.map((b) => (
            <div key={b.id} className="bg-card border border-card-border rounded-lg px-3 py-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{b.leadName ?? `Lead #${b.leadId}`}</div>
                <div className="text-[11px] text-muted-foreground">{b.startsAt ? istLabel(b.startsAt) : "—"} · {b.status}{b.interestedModel ? ` · ${b.interestedModel}` : ""}</div>
              </div>
              {b.status === "booked" && (
                <Button size="sm" variant="outline" onClick={() => cancelBooking.mutate(b.id)}>Cancel</Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
