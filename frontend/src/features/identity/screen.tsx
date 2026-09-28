import { useCallback, useRef, useState } from "react";
import {
  CarFrontIcon, FingerprintIcon, IdCardIcon, InfoIcon, MapPinIcon,
  ScanFaceIcon, SearchIcon, UploadCloudIcon, UserRoundIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageShell } from "@/components/ibvap/page-shell";
import { NothingHere } from "@/components/ibvap/states";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
import { api, isNotFound } from "@/lib/api";
import { relative } from "@/lib/format";
import type { PersonDossier } from "@/lib/types";

const PEOPLE_AI_BASE = "http://127.0.0.1:8002";

type SearchMode = "name" | "govt-id" | "plate" | "photo";

/**
 * The cross-link the SIH problem statement asks for by name: search a
 * person -- by name, by the government ID this deployment mocks, by a
 * vehicle plate, or by an uploaded photo -- and see everywhere they have
 * been seen, face AND vehicle, as one trail.
 *
 * NOT A NEW DATA SOURCE. Every fact this page shows already exists
 * elsewhere: `person_watchlist` (address/owned_plates/govt_id -- explicitly
 * MOCK, standing in for a government registry this deployment does not
 * have) joined against two REAL logs, `watchlist_match` events (a camera
 * actually matched a face or appearance) and `plate_detection` rows (a
 * camera actually read that plate). Backend's personDossier() does the
 * join once; this page is its one screen (see
 * backend/src/l3/person_watchlist.ts's own docstring on why the join is
 * "two real sources through one mock fact", never flattened into a bare
 * "confirmed").
 *
 * PHOTO SEARCH is a two-step call, not a third data source: it asks
 * people_ai_service.py's POST /identify (the SAME WatchlistClient.match()
 * the live cameras use) "whose face is this", gets back a bare name, then
 * asks the backend for that name's dossier -- identical to typing the name
 * in by hand. If nobody is enrolled with a matching face, there is no
 * dossier to show, and the page says so rather than guessing.
 */
export function IdentityLookupScreen() {
  const { role } = useClient();
  const [mode, setMode] = useState<SearchMode>("name");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dossier, setDossier] = useState<PersonDossier | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const runSearch = useCallback(async (searchMode: SearchMode, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setNotFound(false);
    setDossier(null);
    try {
      const result = searchMode === "name" ? await api.personDossierByName(trimmed)
        : searchMode === "govt-id" ? await api.personDossierByGovtId(trimmed)
        : await api.personDossierByPlate(trimmed);
      setDossier(result);
    } catch (cause) {
      if (isNotFound(cause)) setNotFound(true);
      else setError(cause instanceof Error ? cause.message : "search failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const searchByPhoto = useCallback(async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotFound(false);
    setDossier(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const response = await fetch(`${PEOPLE_AI_BASE}/identify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const result = await response.json() as {
        matched?: boolean; name?: string; score?: number; signal?: string; detail?: string;
      };
      if (!response.ok) throw new Error(result.detail ?? "could not read this photo");
      if (!result.matched || !result.name) {
        setNotFound(true);
        return;
      }
      setQuery(result.name);
      const dossierResult = await api.personDossierByName(result.name);
      setDossier(dossierResult);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "could not reach the face service -- is people_ai_service running on :8002?",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  // A merged, chronological trail -- face/appearance sightings and vehicle
  // sightings interleaved by time, because that is the actual question this
  // page answers ("everywhere this identity has shown up"), not two
  // separate lists a reader has to cross-reference by hand.
  const timeline = dossier ? [
    ...dossier.sightings.map((s) => ({
      kind: "person" as const, occurredAt: s.occurredAt, cameraName: s.cameraName,
      signal: s.signal, score: s.score,
    })),
    ...dossier.vehicleSightings.map((v) => ({
      kind: "vehicle" as const, occurredAt: v.occurredAt, cameraName: v.cameraName ?? v.cameraId,
      plateNumber: v.plateNumber, matchStatus: v.matchStatus,
    })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)) : [];

  return (
    <PageShell
      title="Identity lookup"
      description="Search one person by name, government ID, vehicle plate or photo -- see every real face and vehicle sighting linked to them in one trail."
    >
      <Alert>
        <InfoIcon />
        <AlertTitle>Real sightings, joined through a mock registry</AlertTitle>
        <AlertDescription>
          Government ID and vehicle ownership come from a MOCK registry this deployment stands in
          for (no such database is actually connected) -- seeded here as a demo record. Every
          sighting shown is real: an actual face/appearance match from the watchlist, or an actual
          ANPR read of a plate this record claims is owned by this person. A vehicle sighting is
          evidence the plate was seen, not proof this specific person was driving it.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FingerprintIcon className="size-4" /> Search
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(event) => { void searchByPhoto(event.target.files?.[0]); event.target.value = ""; }} />
          <Tabs value={mode} onValueChange={(v) => { setMode(v as SearchMode); setQuery(""); setDossier(null); setNotFound(false); setError(null); }}>
            <TabsList>
              <TabsTrigger value="name" className="gap-1.5"><UserRoundIcon className="size-3.5" /> Name</TabsTrigger>
              <TabsTrigger value="govt-id" className="gap-1.5"><IdCardIcon className="size-3.5" /> Government ID</TabsTrigger>
              <TabsTrigger value="plate" className="gap-1.5"><CarFrontIcon className="size-3.5" /> Vehicle plate</TabsTrigger>
              <TabsTrigger value="photo" className="gap-1.5"><ScanFaceIcon className="size-3.5" /> Photo</TabsTrigger>
            </TabsList>

            {(["name", "govt-id", "plate"] as const).map((tab) => (
              <TabsContent key={tab} value={tab} className="mt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void runSearch(tab, query); }}
                    placeholder={
                      tab === "name" ? "e.g. Karamjit Singh"
                        : tab === "govt-id" ? "e.g. IND-PB-2291-04821"
                        : "e.g. PB 02 AK 4821"
                    }
                    className="max-w-xs"
                    disabled={busy}
                  />
                  <Button size="sm" disabled={!query.trim() || busy} onClick={() => void runSearch(tab, query)}>
                    {busy ? <Spinner data-icon="inline-start" /> : <SearchIcon data-icon="inline-start" />}
                    Search
                  </Button>
                </div>
              </TabsContent>
            ))}

            <TabsContent value="photo" className="mt-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                  <UploadCloudIcon data-icon="inline-start" />
                  {busy ? "Reading photo…" : "Upload a photo"}
                </Button>
                <p className="text-sm text-muted-foreground">
                  Matched against the SAME face/appearance watchlist the live cameras use.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notFound && (
        <NothingHere
          icon={FingerprintIcon}
          title="No record found"
          description={
            mode === "photo"
              ? "No enrolled watchlist face or appearance matched this photo."
              : "No person record matches that search. Check the spelling, or try a different search mode."
          }
        />
      )}

      {dossier && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-2"><UserRoundIcon className="size-4" /> {dossier.profile.name}</span>
                <Badge variant="outline">searched as {role}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-start gap-2 text-sm">
                  <IdCardIcon className="mt-0.5 size-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Government ID (mock)</p>
                    <p className="font-mono">{dossier.profile.govt_id ?? "not on file"}</p>
                  </div>
                </div>
                <div className="flex items-start gap-2 text-sm">
                  <MapPinIcon className="mt-0.5 size-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Address (mock)</p>
                    <p>{dossier.profile.address ?? "not on file"}</p>
                  </div>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">Registered vehicles (mock ownership claim)</p>
                {dossier.profile.owned_plates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None on file.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {dossier.profile.owned_plates.map((plate) => (
                      <Badge key={plate} variant="secondary" className="font-mono">{plate}</Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {dossier.profile.face_embedding ? (
                  <Badge variant="secondary">face enrolled</Badge>
                ) : dossier.profile.appearance_embedding ? (
                  <Badge variant="secondary">clothing signature only</Badge>
                ) : (
                  <Badge variant="outline">no live-camera signature enrolled yet</Badge>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Sighting trail ({timeline.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No sightings yet -- no camera has matched this person's face/appearance, and no
                  camera has read a plate this record claims they own.
                </p>
              ) : (
                <ul className="space-y-2">
                  {timeline.map((entry, index) => (
                    <li key={index} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm last:border-0 last:pb-0">
                      <div className="flex items-center gap-2">
                        {entry.kind === "person" ? (
                          <>
                            <Badge variant={entry.signal === "face" ? "destructive" : "secondary"}>
                              <ScanFaceIcon className="size-3" /> {(entry.score * 100).toFixed(0)}%
                              {entry.signal === "appearance" ? " (clothing)" : " (face)"}
                            </Badge>
                            <span className="text-muted-foreground">seen at {entry.cameraName}</span>
                          </>
                        ) : (
                          <>
                            <Badge variant={entry.matchStatus === "MATCHED" ? "destructive" : "outline"}>
                              <CarFrontIcon className="size-3" /> {entry.plateNumber}
                            </Badge>
                            <span className="text-muted-foreground">
                              vehicle seen at {entry.cameraName}
                            </span>
                          </>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">{relative(entry.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}
