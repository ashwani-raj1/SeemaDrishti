/**
 * The Intelligence screen: two modes that share one evidence panel.
 *
 * AI Intelligence is conversational -- an operator asks in plain language and
 * the node answers from its own record. Manual Search is the opposite: exact
 * filters, straight to the API, no model in the path at all. They are kept
 * visibly apart because they are different tools for different moments. An
 * operator who knows the plate does not want to phrase a question, and an
 * operator exploring a busy night does not want to fill in six dropdowns.
 *
 * What they share is the right-hand panel and the result model behind it, so
 * evidence looks the same however it was found.
 */
import { useEffect, useState } from "react";
import {
  MessageSquarePlusIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageShell } from "@/components/ibvap/page-shell";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { ChatMessageList, type ChatMessage } from "./components/chat-message-list";
import { ContextualPanel } from "./components/contextual-panel";
import { SnapshotModal } from "./components/snapshot-modal";
import { askAssistant } from "./ai-chat";
import { ManualSearch } from "./manual-search";
import type { IntelligenceResult } from "./result-model";

const SESSION_KEY = "ibvap.intelligence.session.v2";

type Mode = "ai" | "manual";

const welcomeMessage = (): ChatMessage => ({
  id: "init-1",
  sender: "assistant",
  text:
    "Welcome to **SeemaDrishti Intelligence**.\n\nAsk me about anything in this post's recorded surveillance data:\n- 🔍 **Vehicles & plates** — sightings, first and last seen, timelines, watchlist matches\n- 📸 **Evidence** — the images recorded against a detection\n- 📍 **Cameras & geography** — position, bearing, field of view, grid reference\n- 🚨 **Incidents & crossings** — intrusions, person crossings, operator decisions\n\nIf you already know exactly what you want, switch to **Manual search** for precise filters.",
  timestamp: new Date().toISOString(),
  suggestedPrompts: [
    "Find vehicle PB 02 AK 4821",
    "Has DL 1C AA 1111 been seen?",
    "Are there any open critical incidents?",
    "Where is the northern fence camera?",
  ],
});

/**
 * The chat belongs to this browser tab, not to the deployment. Surveillance
 * questions an operator asked are not something to persist across devices or
 * leave lying around after the shift.
 */
function restoreSession(): ChatMessage[] {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) return [welcomeMessage()];
    const parsed = JSON.parse(saved) as { messages?: ChatMessage[] };
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) throw new Error("invalid session");
    return parsed.messages;
  } catch {
    return [welcomeMessage()];
  }
}

export function IntelligenceScreen() {
  const { cameras: clientCameras, site } = useClient();
  const [mode, setMode] = useState<Mode>("ai");
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(restoreSession);
  const [queryInput, setQueryInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentResult, setCurrentResult] = useState<IntelligenceResult | null>(null);
  const [enlargedSnapshot, setEnlargedSnapshot] = useState<{ url: string | null; label: string } | null>(null);

  // Zone names are needed to resolve "the northern fence" to an actual zone id.
  useEffect(() => {
    let cancelled = false;
    api.zones()
      .then((result) => {
        if (!cancelled) setZones(result.map((zone) => ({ id: zone.id, name: zone.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ messages }));
  }, [messages]);

  const handleSend = async (userPrompt: string) => {
    const trimmed = userPrompt.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      text: trimmed,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setQueryInput("");
    setLoading(true);

    try {
      const response = await askAssistant(trimmed, {
        cameras: clientCameras.map((c) => ({ id: c.id, name: c.name })),
        zones,
      });

      setCurrentResult(response.result);

      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        sender: "assistant",
        text: response.answer,
        timestamp: new Date().toISOString(),
        snapshotUrl: response.result.snapshot?.url ?? null,
        snapshotLabel: response.result.snapshot?.label,
        suggestedPrompts: response.suggestedPrompts,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      // Reaching here means the node itself is unreachable -- both rungs failed.
      // That is worth telling the operator, unlike a model being unavailable.
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-err-${Date.now()}`,
          sender: "assistant",
          text: `⚠️ I could not reach the edge node (${(err as Error)?.message ?? "no response"}). Check the connection and try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleClearChat = () => {
    setCurrentResult(null);
    setMessages([
      {
        id: `init-${Date.now()}`,
        sender: "assistant",
        text: "Conversation cleared. Ready for your query.",
        timestamp: new Date().toISOString(),
        suggestedPrompts: [
          "Find vehicle PB 02 AK 4821",
          "Where is the northern fence camera?",
          "Are there any open critical incidents?",
          "Show activity around Northern Fence",
        ],
      },
    ]);
  };

  /** A row in the evidence panel becomes a question, so it lands in the chat. */
  const handleFollowUp = (prompt: string) => {
    setMode("ai");
    void handleSend(prompt);
  };

  return (
    <PageShell
      title="Intelligence"
      description="Ask, find and analyze anything across your surveillance system"
      actions={
        mode === "ai" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearChat}
            className="h-9 border-blue-200 bg-white text-blue-700 shadow-sm hover:bg-blue-50"
          >
            <MessageSquarePlusIcon className="mr-1.5 h-4 w-4" />
            New chat
          </Button>
        ) : undefined
      }
    >
      <div className="grid h-[calc(100vh-174px)] min-h-[590px] grid-cols-1 gap-3 xl:grid-cols-12">
        {/* ---------------------------------------------------- left: the two modes */}
        <div className="flex min-h-0 flex-col xl:col-span-8">
          {/* The two modes are visibly separate controls, not a blended search
              box: an operator should never have to wonder whether a model is
              reading what they type. */}
          <div className="mb-2 flex shrink-0 items-center gap-2">
            <div className="flex rounded-xl border border-blue-100 bg-white p-1 shadow-sm">
              <button
                type="button"
                onClick={() => setMode("ai")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  mode === "ai" ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:text-blue-700"
                }`}
              >
                <SparklesIcon className="h-3.5 w-3.5" />
                AI Intelligence
              </button>
              <button
                type="button"
                onClick={() => setMode("manual")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  mode === "manual" ? "bg-slate-800 text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <SearchIcon className="h-3.5 w-3.5" />
                Manual Search
              </button>
            </div>
            <span className="text-[11px] text-slate-400">
              {mode === "ai"
                ? "Natural language · answered from this post's record"
                : "Exact filters · no AI in the path"}
            </span>
          </div>

          {/* Kept mounted rather than swapped so a search in progress survives a
              glance at the chat and back. */}
          <div className={mode === "ai" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_8px_30px_rgba(37,99,235,.06)]">
              <div className="flex items-center justify-between border-b border-blue-100 bg-gradient-to-r from-blue-50/60 to-white px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
                    <SparklesIcon className="h-4 w-4" />
                  </div>
                  <div>
                    <span className="block text-sm font-semibold text-slate-900">AI intelligence</span>
                    <span className="block text-[11px] text-slate-500">
                      {site?.name ?? "BOP Attari"} · historical surveillance records
                    </span>
                  </div>
                </div>
              </div>

              <ChatMessageList
                messages={messages}
                loading={loading}
                onSelectPrompt={(p) => void handleSend(p)}
                onOpenSnapshot={(url, label) => setEnlargedSnapshot({ url, label })}
              />

              <div className="border-t border-blue-100 bg-slate-50/70 p-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSend(queryInput);
                  }}
                  className="flex items-center gap-2 rounded-xl border border-blue-100 bg-white p-1.5 shadow-sm"
                >
                  <Input
                    placeholder="Ask anything about your surveillance data…"
                    value={queryInput}
                    onChange={(e) => setQueryInput(e.target.value)}
                    disabled={loading}
                    className="border-0 bg-transparent text-slate-900 shadow-none placeholder:text-slate-400 focus-visible:ring-0"
                  />
                  <Button
                    type="submit"
                    disabled={loading || !queryInput.trim()}
                    className="h-9 shrink-0 bg-blue-600 px-3 text-white hover:bg-blue-700"
                  >
                    <SendIcon className="h-4 w-4" />
                    <span className="sr-only">Ask</span>
                  </Button>
                </form>
                <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-slate-400">
                  <span>Searches persistent surveillance records. No raw video is processed.</span>
                  <span className="font-mono text-[10px]">IBVAP Intelligence</span>
                </div>
              </div>
            </div>
          </div>

          <div className={mode === "manual" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <ManualSearch onResult={setCurrentResult} />
          </div>
        </div>

        {/* ----------------------------------------------- right: shared evidence */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_8px_30px_rgba(37,99,235,.06)] xl:col-span-4">
          <div className="flex items-center gap-1.5 border-b border-blue-100 bg-white p-3 text-sm font-semibold text-slate-900">
            <SparklesIcon className="h-4 w-4 text-blue-600" />
            Intelligence details
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <ContextualPanel result={currentResult} onSelectPrompt={handleFollowUp} />
          </div>
        </div>
      </div>

      <SnapshotModal
        open={Boolean(enlargedSnapshot)}
        onOpenChange={(open) => !open && setEnlargedSnapshot(null)}
        snapshot={enlargedSnapshot?.url ?? null}
        label={enlargedSnapshot?.label ?? "Detection snapshot"}
      />
    </PageShell>
  );
}
