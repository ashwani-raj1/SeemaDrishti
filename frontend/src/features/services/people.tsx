import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoIcon } from "lucide-react";
import { ServiceShell } from "./service-shell";

/**
 * People, tracked within one camera.
 *
 * WHAT THIS IS: ByteTrack identities from the shared detection pass, with the
 * recent path each one has walked. It answers "how many, where, and for how
 * long" on one feed.
 *
 * WHAT THIS IS NOT, and the page says so out loud: re-identification. The
 * tracker carries no appearance model, so a person who walks behind a wall for
 * four seconds comes back as a NEW track, and a person who walks from one
 * camera to the next has no relationship to themselves. The interface for an
 * embedding model exists in the vision service (`modules/reid.py`) and its
 * provider is a no-op that returns "I don't know" for every crop.
 *
 * The notice below is not an apology. A console that let an operator believe
 * track 7 on this camera is track 7 on the next one would produce confident,
 * wrong conclusions -- which is worse than the gap it papers over.
 */
export function PeopleScreen() {
  return (
    <ServiceShell
      title="People"
      description="Person detection and within-camera tracking, with recent movement trails."
      module="multi_human"
      eventKinds={["reidentification"]}
    >
      {() => (
        <Alert>
          <InfoIcon />
          <AlertTitle>Tracks are per camera, and per appearance</AlertTitle>
          <AlertDescription>
            A track id identifies a sequence of detections on this camera — not a
            person. A long occlusion produces a new id, and ids are never shared
            between cameras. Cross-camera matching needs an appearance model,
            which is wired but deliberately not enabled: its CPU cost has not
            been measured on the hardware this has to run on.
          </AlertDescription>
        </Alert>
      )}
    </ServiceShell>
  );
}
