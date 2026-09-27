import { useEffect, useRef, type ReactNode } from "react";
import {
  BotIcon,
  CameraIcon,
  ChevronRightIcon,
  SparklesIcon,
  UserIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { isImageUrl } from "../result-model";

/**
 * A chat turn.
 *
 * There is deliberately no field here for which tool ran, which endpoint was
 * called or what the model was given. The operator asked a question about their
 * border; the mechanism that answered it is not their concern, and once a field
 * like that exists on a rendered message somebody will eventually display it.
 */
export interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  timestamp: string;
  snapshotUrl?: string | null;
  snapshotLabel?: string;
  suggestedPrompts?: string[];
}

interface ChatMessageListProps {
  messages: ChatMessage[];
  loading: boolean;
  onSelectPrompt: (prompt: string) => void;
  onOpenSnapshot?: (url: string, label: string) => void;
}

/** Render the small, controlled Markdown vocabulary produced by the agent. */
function renderInline(source: string): ReactNode[] {
  const text = source.replace(/\\([*_`])/g, "$1");
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-slate-100 px-1 py-0.5 text-[.85em] text-slate-700">{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  });
}

function MessageText({ text }: { text: string }) {
  return (
    <div className="space-y-2 font-sans">
      {text.replace(/\\n/g, "\n").split(/\n{2,}/).map((block, index) => {
        const lines = block.split("\n");
        const isList = lines.every((line) => /^[-*]\s+/.test(line));
        if (isList) {
          return <ul key={index} className="list-disc space-y-1 pl-4">{lines.map((line, lineIndex) => <li key={lineIndex}>{renderInline(line.replace(/^[-*]\s+/, ""))}</li>)}</ul>;
        }
        return <p key={index}>{lines.map((line, lineIndex) => <span key={lineIndex}>{renderInline(line)}{lineIndex < lines.length - 1 && <br />}</span>)}</p>;
      })}
    </div>
  );
}

export function ChatMessageList({
  messages,
  loading,
  onSelectPrompt,
  onOpenSnapshot,
}: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <div className="flex-1 overflow-y-auto bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] p-5 space-y-5">
      {messages.map((msg) => {
        const isUser = msg.sender === "user";

        return (
          <div
            key={msg.id}
            className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
          >
            {/* Avatar */}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
                isUser
                  ? "bg-slate-100 text-slate-600 border border-slate-200"
                  : "bg-blue-50 text-blue-600 border border-blue-100"
              }`}
            >
              {isUser ? <UserIcon className="w-4 h-4" /> : <BotIcon className="w-4 h-4" />}
            </div>

            {/* Content Bubble */}
            <div className={`flex flex-col space-y-2 max-w-[82%] ${isUser ? "items-end" : "items-start"}`}>
              <div
                className={`p-3.5 rounded-xl text-sm leading-relaxed ${
                  isUser
                    ? "bg-blue-600 border border-blue-600 text-white rounded-tr-none shadow-sm"
                    : "bg-white border border-blue-100 text-slate-700 rounded-tl-none shadow-sm"
                }`}
              >
                <MessageText text={msg.text} />

                {/* Inline Snapshot preview if returned with response */}
                {msg.snapshotUrl && (
                  <div className="mt-3 pt-2.5 border-t border-blue-100">
                    <div className="text-[11px] text-slate-500 font-medium mb-1.5 flex items-center gap-1">
                      <CameraIcon className="w-3 h-3 text-blue-500" />
                      {msg.snapshotLabel || "Relevant Snapshot"}
                    </div>
                    <div
                      className="relative max-w-xs rounded-md overflow-hidden border border-blue-100 bg-slate-50 cursor-pointer group"
                      onClick={() =>
                        onOpenSnapshot && onOpenSnapshot(msg.snapshotUrl!, msg.snapshotLabel || "Snapshot")
                      }
                    >
                      {isImageUrl(msg.snapshotUrl) ? (
                        <img
                          src={msg.snapshotUrl}
                          alt="Detection Snapshot"
                          className="max-h-40 w-full object-cover group-hover:scale-105 transition-transform duration-200"
                        />
                      ) : (
                        /* A detection whose image was never stored carries a
                           placeholder token instead of a URL. That token means
                           nothing to an operator, so it is not shown. */
                        <div className="p-3 text-center text-xs text-slate-500 bg-slate-50">
                          <CameraIcon className="w-6 h-6 text-slate-400 mx-auto mb-1" />
                          <span>No stored image for this detection.</span>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs font-medium text-white">
                        Enlarge Snapshot
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Timestamp */}
              <span className="text-[10px] text-slate-400 font-mono px-1">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>

              {/* Suggested Follow-up Prompts */}
              {!isUser && msg.suggestedPrompts && msg.suggestedPrompts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {msg.suggestedPrompts.map((prompt, idx) => (
                    <Button
                      key={idx}
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px] bg-white border-blue-100 hover:border-blue-300 hover:text-blue-700 text-slate-600 py-0 px-2.5 rounded-full"
                      onClick={() => onSelectPrompt(prompt)}
                    >
                      <ChevronRightIcon className="w-3 h-3 mr-0.5 text-blue-500" />
                      {prompt}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {loading && (
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-blue-50 text-blue-600 border border-blue-100">
            <SparklesIcon className="w-4 h-4 animate-pulse" />
          </div>
          <div className="p-3 rounded-xl bg-white border border-blue-100 text-slate-500 text-xs rounded-tl-none flex items-center gap-2 shadow-sm">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
            <span>Searching the record…</span>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
