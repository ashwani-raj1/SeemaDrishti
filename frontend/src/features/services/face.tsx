import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoIcon } from "lucide-react";
import { ServiceShell } from "./service-shell";

/**
 * Face detection, cascaded inside a tracked person's box.
 *
 * WHAT THIS IS: YuNet (`ibvap/modules/face.py`) searched only inside the
 * upper fraction of a person box the shared detection pass already found --
 * a box and a confidence score, nothing else. It exists as the *precondition*
 * for a later watchlist match, the same way `ibvap/modules/anpr.py` localises
 * a vehicle before OCR ever runs on it.
 *
 * WHAT THIS IS NOT, and the page says so out loud: recognition. YuNet cannot
 * tell one face from another -- it has no embedding, no gallery, no notion of
 * "this is the same face as before". Nothing on this page, or behind it,
 * matches a face to a name or to another face. That capability, if it is ever
 * built, is a separate, later module with its own measured accuracy -- not
 * something a detection box may quietly imply.
 */
export function FaceScreen() {
  return (
    <ServiceShell
      title="Face detection"
      description="Cascaded face detection inside each tracked person's box, as a precondition for a later watchlist match."
      module="face"
      eventKinds={[]}
    >
      {() => (
        <Alert>
          <InfoIcon />
          <AlertTitle>Detection only -- never recognition</AlertTitle>
          <AlertDescription>
            YuNet outputs a bounding box and a confidence score. It cannot
            tell one face from another, so nothing here matches a face to a
            name or links it to a face seen on another camera. Watchlist
            matching would be a separate capability, built and measured on
            its own -- not something this module implies today.
          </AlertDescription>
        </Alert>
      )}
    </ServiceShell>
  );
}
