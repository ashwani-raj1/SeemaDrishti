import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoIcon, ShieldAlertIcon } from "lucide-react";
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
 * This page used to say recognition did not exist at all. It does now --
 * built and measured on real footage, not asserted -- so the copy below
 * describes what is actually true today, with its actual measured limits,
 * rather than either overclaiming or denying it exists.
 */
export function FaceScreen() {
  return (
    <ServiceShell
      title="Face detection"
      description="Cascaded face detection inside each tracked person's box, matched against the watchlist when a face signature is enrolled."
      module="face"
      eventKinds={["watchlist_match"]}
    >
      {() => (
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
                  <span><strong>Amber</strong> — that face matched a named watchlist entry. Real evidence (verified on real footage: same-person similarity averaged 0.60, with real variance), not a certainty on a single frame.</span>
                </span>
              </span>
            </AlertDescription>
          </Alert>

          <Alert>
            <ShieldAlertIcon />
            <AlertTitle>No amber boxes? Nobody's enrolled yet</AlertTitle>
            <AlertDescription>
              This page only detects and compares — enrolling a person, by
              name and photo, happens on the{" "}
              <Link to="/services/people" className="underline">People page's Watchlist card</Link>.
              Once someone is enrolled with a face signature, their matches
              show up here, on every camera, automatically.
            </AlertDescription>
          </Alert>
        </div>
      )}
    </ServiceShell>
  );
}
