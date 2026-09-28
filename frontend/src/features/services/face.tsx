import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InfoIcon, ScanFaceIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { ServiceShell } from "./service-shell";

/**
 * Face detection, cascaded inside a tracked person's box -- and, when the
 * watchlist has an entry with a face signature, face MATCHING too.
 *
 * TWO DIFFERENT CLAIMS ON ONE PICTURE, AND THE COLOUR IS THE ONLY THING
 * TELLING THEM APART -- see the legend below, and `camera-feed.tsx`'s own
 * draw loop for where these colours are chosen:
 *
 *   lime    YuNet (`ibvap/modules/face.py`'s FaceDetector) found a face.
 *           A box and a score, nothing else -- it cannot tell one face
 *           from another. This is the precondition for a later match, the
 *           same way `ibvap/modules/anpr.py` localises a vehicle before
 *           OCR ever runs on it.
 *
 *   amber   That face was compared against the watchlist (SFace, real
 *           embeddings, see modules/face.py's own docstring for measured
 *           real-footage accuracy) and matched a named entry. This IS an
 *           identity claim -- weaker evidence than a human confirming it,
 *           but real evidence, not a guess.
 *
 * THE SEARCH WIDGET BELOW IS A DELIBERATE EXCEPTION to ServiceShell's own
 * "no action button near the live feed" rule (see that file's docstring):
 * an operator who wants to search for a face lands on THIS page looking
 * for it, and pointing them at a different page for the one thing they
 * came here to do is worse UX than the shell's usual read-only posture.
 * It is the SAME enrolment `people_ai_service.py` already exposes (POST
 * /watchlist) -- not a second implementation, not a separate list. Add
 * someone here or on the People page's Watchlist card and it is the one
 * watchlist either way, matched on every camera, including whichever one
 * is selected above.
 */

const PEOPLE_AI_BASE = "http://127.0.0.1:8002";

interface WatchlistEntry {
  name: string;
  hasFace: boolean;
  hasAppearance: boolean;
}

function FaceSearch() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ name: string; hasFace: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadWatchlist = useCallback(async () => {
    try {
      const response = await fetch(`${PEOPLE_AI_BASE}/watchlist`);
      if (!response.ok) return;
      const result = await response.json() as {
        entries: Array<{ name: string; has_face: boolean; has_appearance: boolean }>;
      };
      setWatchlist(result.entries.map((entry) => ({
        name: entry.name, hasFace: entry.has_face, hasAppearance: entry.has_appearance,
      })));
    } catch {
      // The people/face service being offline is shown by the upload
      // button's own error the moment someone tries to use it -- no need
      // to also blank the page on a background refresh failing.
    }
  }, []);

  useEffect(() => { void loadWatchlist(); }, [loadWatchlist]);

  const upload = useCallback(async (file?: File) => {
    const trimmed = name.trim();
    if (!file || !trimmed) return;
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const response = await fetch(`${PEOPLE_AI_BASE}/watchlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, image: dataUrl }),
      });
      const result = await response.json() as { detail?: string; face_detected?: boolean };
      if (!response.ok) throw new Error(result.detail ?? "could not read this photo");
      setLastResult({ name: trimmed, hasFace: result.face_detected === true });
      setName("");
      await loadWatchlist();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "could not reach the face service -- is people_ai_service running on :8002?",
      );
    } finally {
      setBusy(false);
    }
  }, [name, loadWatchlist]);

  const remove = useCallback(async (target: string) => {
    setWatchlist((entries) => entries.filter((entry) => entry.name !== target));
    try {
      await fetch(`${PEOPLE_AI_BASE}/watchlist/${encodeURIComponent(target)}`, { method: "DELETE" });
    } catch {
      // Best-effort, same reasoning as people.tsx's own removeWatchlistEntry.
    }
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScanFaceIcon className="size-4" /> Search by face
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        <div className="flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)}
            placeholder="Name this person" className="max-w-[220px]" disabled={busy} />
          <Button size="sm" variant="outline" disabled={!name.trim() || busy}
            onClick={() => fileRef.current?.click()}>
            <ScanFaceIcon /> Upload photo
          </Button>
          {busy && <span className="text-xs text-muted-foreground">Reading the photo…</span>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {lastResult && !error && (
          <p className="text-sm text-muted-foreground">
            {lastResult.hasFace
              ? `${lastResult.name} enrolled with a real face signature -- watch for an amber box on any camera.`
              : `${lastResult.name} enrolled, but no face was found in that photo -- only clothing colour will be compared, which is far weaker (see the legend below).`}
          </p>
        )}
        {watchlist.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody enrolled yet. Name someone and upload a clear photo of their
            face -- they are then compared against every tracked person, on
            every camera, live.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {watchlist.map((entry) => (
              <Badge key={entry.name} variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1">
                {entry.name}
                <span className="text-[10px] text-muted-foreground">
                  {entry.hasFace ? "face" : entry.hasAppearance ? "clothing only" : "no signature"}
                </span>
                <button type="button" onClick={() => void remove(entry.name)}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20" aria-label={`Remove ${entry.name}`}>
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FaceScreen() {
  return (
    <ServiceShell
      title="Face detection"
      description="Cascaded face detection inside each tracked person's box, matched against the watchlist when a face signature is enrolled."
      module="face"
      eventKinds={["watchlist_match"]}
    >
      {() => (
        <div className="space-y-4">
          <FaceSearch />

          <div className="grid gap-4 lg:grid-cols-2">
            <Alert>
              <InfoIcon />
              <AlertTitle>What the two colours mean</AlertTitle>
              <AlertDescription>
                <span className="mt-1 flex flex-col gap-1.5">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: "#a3e635" }} />
                    <span><strong>Lime</strong> — a face was found. Detection only: no name, no comparison to anyone.</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: "#f59e0b" }} />
                    <span><strong>Amber</strong> — that face matched a named watchlist entry above. Real evidence (verified on real footage: same-person similarity averaged 0.60, with real variance), not a certainty on a single frame.</span>
                  </span>
                </span>
              </AlertDescription>
            </Alert>

            <Alert>
              <ShieldAlertIcon />
              <AlertTitle>One watchlist, everywhere</AlertTitle>
              <AlertDescription>
                Enrolling here is the same list the{" "}
                <Link to="/services/people" className="underline">People page's Watchlist card</Link>{" "}
                uses -- add someone from either page, and their matches show
                up on every camera, single view or the multi-camera grid alike.
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}
    </ServiceShell>
  );
}
