import { useState } from "react";
import { Settings2, Phone, MessageSquare, Mic, Bot, CheckCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function Settings() {
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    toast.success("Settings saved");
    setTimeout(() => setSaved(false), 2000);
  }

  const sections = [
    {
      icon: <Phone size={16} />,
      title: "Exotel Voice Configuration",
      desc: "Virtual number and API credentials for call handling",
      fields: [
        { label: "Virtual Number", placeholder: "Your Exotel virtual number", env: "EXOTEL_VIRTUAL_NUMBER" },
        { label: "Account SID", placeholder: "Exotel SID", env: "EXOTEL_SID" },
        { label: "API Key", placeholder: "Exotel API Key", env: "EXOTEL_API_KEY" },
      ],
    },
    {
      icon: <Mic size={16} />,
      title: "Sarvam AI (STT/TTS)",
      desc: "Speech-to-text and text-to-speech for multilingual voice",
      fields: [
        { label: "API Key", placeholder: "Sarvam API subscription key", env: "SARVAM_API_KEY" },
      ],
    },
    {
      icon: <MessageSquare size={16} />,
      title: "BotSpace WhatsApp",
      desc: "WhatsApp messaging for call summaries and brochures",
      fields: [
        { label: "API Key", placeholder: "BotSpace API key", env: "BOTSPACE_API_KEY" },
        { label: "Phone Number ID", placeholder: "WhatsApp Phone Number ID", env: "BOTSPACE_PHONE_NUMBER_ID" },
      ],
    },
    {
      icon: <Bot size={16} />,
      title: "AI Brain (OpenAI)",
      desc: "GPT model for intent detection, scoring, and self-learning",
      fields: [
        { label: "OpenAI API Key", placeholder: "sk-...", env: "OPENAI_API_KEY" },
      ],
    },
    {
      icon: <Phone size={16} />,
      title: "Sales Transfer",
      desc: "When a lead goes hot, AI transfers the call to your salesperson",
      fields: [
        { label: "Sales Person Number", placeholder: "10-digit mobile for hot lead transfers", env: "SALES_TRANSFER_NUMBER" },
      ],
    },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2"><Settings2 size={20} />Settings</h1>
        <p className="text-xs text-muted-foreground mt-1">Configure your AI voice agent integrations</p>
      </div>

      <div className="bg-card border border-primary/30 rounded-lg p-4 text-sm text-foreground/80">
        <div className="flex items-start gap-2">
          <CheckCircle size={14} className="text-green-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-sm">All credentials are stored as environment secrets</div>
            <div className="text-xs text-muted-foreground mt-0.5">API keys are securely stored in Replit Secrets. Update them there for security. Values shown here are masked.</div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.title} className="bg-card border border-card-border rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center text-muted-foreground">
                {section.icon}
              </div>
              <div>
                <div className="text-sm font-semibold">{section.title}</div>
                <div className="text-xs text-muted-foreground">{section.desc}</div>
              </div>
            </div>
            <div className="space-y-3 pl-10">
              {section.fields.map((f) => (
                <div key={f.env}>
                  <Label className="text-xs mb-1 block text-muted-foreground">{f.label}</Label>
                  <Input
                    type="password"
                    placeholder={f.placeholder}
                    defaultValue="••••••••••••••••"
                    className="text-sm font-mono"
                    data-testid={`setting-${f.env.toLowerCase()}`}
                    readOnly
                  />
                  <div className="text-[10px] text-muted-foreground/60 mt-0.5">Env: <code className="font-mono">{f.env}</code> — update via Replit Secrets</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Webhook info */}
      <div className="bg-card border border-card-border rounded-lg p-5 space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center text-muted-foreground">
            <Phone size={16} />
          </div>
          <div>
            <div className="text-sm font-semibold">Exotel Webhook URLs</div>
            <div className="text-xs text-muted-foreground">Configure these in your Exotel dashboard</div>
          </div>
        </div>
        <div className="pl-10 space-y-2">
          {[
            { label: "Inbound Call URL", path: "/api/webhooks/exotel/inbound" },
            { label: "Call Status URL", path: "/api/webhooks/exotel/status" },
            { label: "Voice Stream URL", path: "/api/webhooks/voice/stream" },
          ].map(({ label, path }) => (
            <div key={path}>
              <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
              <div className="text-xs font-mono bg-muted/50 px-3 py-1.5 rounded border border-border text-foreground/80 break-all">
                {`https://[your-domain]${path}`}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Button onClick={handleSave} className="w-full" data-testid="save-settings-button">
        {saved ? "Saved!" : "Save Settings"}
      </Button>
    </div>
  );
}
