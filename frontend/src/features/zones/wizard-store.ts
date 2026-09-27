import { create } from "zustand";
import type { DraftTarget } from "./target-editor";
import type { ShapeDraft } from "./shape-canvas";
import type { MonitoringZone, ZoneKind } from "@/lib/types";

/**
 * Everything a new zone is, before any of it has been sent anywhere.
 *
 * WHY A STORE AND NOT `useState` IN THE DIALOG. The wizard is three stages over
 * N cameras, and the same draft is read and written by the camera list, the map
 * panel, the drawing surface, the per-camera target editors and the footer,
 * which sit at four different depths. Threading a setter through all of them
 * was the version this replaced; it was where the old dialog's state bugs came
 * from (the name kept following an area it was no longer on).
 *
 * WHY NOT PERSISTED, unlike `client/console-store.ts`. A half-drawn zone is not
 * a preference -- restoring one a week later would offer shapes drawn against
 * camera views that have since moved, with nothing on screen saying so. The
 * store is cleared on close, and `reset()` is called on open as well because
 * "the last run crashed" is exactly when a stale draft would survive.
 *
 * THE INVARIANT THIS TYPE ENFORCES: nothing here has an id from the node, and
 * no field is a server response. It is all input, so there is never a question
 * of whether some part of it has already been written -- until `create()`
 * succeeds, nothing has.
 */

/** A camera chosen for the new zone, and the shape drawn for it. */
export interface DraftCamera {
  cameraId: string;
  /**
   * Null until somebody draws it.
   *
   * Not pre-filled with the placeholder on purpose: "has a shape" and "has the
   * stock shape" must stay distinguishable in the UI, because the second one
   * is what `placed = 0` means and what stops the detector alerting.
   */
  shape: ShapeDraft | null;
  /**
   * This camera's exceptions to the zone policy, or null to follow it.
   *
   * Null rather than a copy of the zone list: a copy would freeze the policy at
   * the moment the expander was opened, so a later edit to the zone's targets
   * would silently fail to reach a camera nobody meant to except.
   */
  targets: DraftTarget[] | null;
}

export type WizardStage = "place" | "draw" | "policy";

export const STAGES: WizardStage[] = ["place", "draw", "policy"];

interface WizardState {
  /**
   * The zone being edited, or null when this is a new one.
   *
   * The only difference between the two modes. Both draft the entire zone and
   * send it in one call -- `POST /api/zones` or `PUT /api/zones/:id` -- so
   * neither can leave a half-applied zone behind, and there is exactly one
   * screen to learn.
   */
  editing: string | null;
  stage: WizardStage;
  name: string;
  /** Once typed into, the name stops following anything else. */
  nameEdited: boolean;
  kind: ZoneKind;
  area: string | null;
  cameras: DraftCamera[];
  targets: DraftTarget[];
  reason: string;
  /** Which camera the map/feed panel is showing, and which stage 2 is on. */
  focused: string | null;

  setStage: (stage: WizardStage) => void;
  setName: (name: string) => void;
  setKind: (kind: ZoneKind) => void;
  setArea: (area: string | null) => void;
  toggleCamera: (cameraId: string) => void;
  setShape: (cameraId: string, shape: ShapeDraft | null) => void;
  setCameraTargets: (cameraId: string, targets: DraftTarget[] | null) => void;
  setTargets: (targets: DraftTarget[]) => void;
  setReason: (reason: string) => void;
  focus: (cameraId: string | null) => void;
  reset: () => void;
  /** Load an existing zone into the draft, for edit mode. */
  load: (zone: MonitoringZone) => void;
}

/** A sensible opening policy, so the list is never empty on arrival. */
export const STARTING_TARGETS: DraftTarget[] = [
  { class: "person", severity: "CRITICAL", action: "alert" },
  { class: "vehicle", severity: "WARNING", action: "alert" },
  { class: "cattle", severity: "INFO", action: "log_only" },
];

const EMPTY = {
  editing: null as string | null,
  stage: "place" as WizardStage,
  name: "",
  nameEdited: false,
  kind: "fence_line" as ZoneKind,
  area: null,
  cameras: [] as DraftCamera[],
  targets: STARTING_TARGETS,
  reason: "",
  focused: null as string | null,
};

export const useWizardStore = create<WizardState>()((set) => ({
  ...EMPTY,

  setStage: (stage) => set({ stage }),
  setName: (name) => set({ name, nameEdited: true }),
  setKind: (kind) => set({ kind }),

  /**
   * The area is a label, so it can also propose a name -- but only until
   * somebody types one. Keeping an auto-filled name after the area changed is
   * how a zone ends up called "Fence line north" while watching the waterline.
   */
  setArea: (area) =>
    set((state) => ({
      area,
      name: state.nameEdited || !area ? state.name : area,
    })),

  toggleCamera: (cameraId) =>
    set((state) => {
      const held = state.cameras.some((camera) => camera.cameraId === cameraId);
      if (held) {
        const cameras = state.cameras.filter((camera) => camera.cameraId !== cameraId);
        return {
          cameras,
          // Unticking the camera the panel was showing must not leave the map
          // pinned to a camera no longer in the zone.
          focused: state.focused === cameraId ? (cameras[0]?.cameraId ?? null) : state.focused,
        };
      }
      return {
        cameras: [...state.cameras, { cameraId, shape: null, targets: null }],
        focused: state.focused ?? cameraId,
      };
    }),

  setShape: (cameraId, shape) =>
    set((state) => ({
      cameras: state.cameras.map((camera) =>
        camera.cameraId === cameraId ? { ...camera, shape } : camera,
      ),
    })),

  setCameraTargets: (cameraId, targets) =>
    set((state) => ({
      cameras: state.cameras.map((camera) =>
        camera.cameraId === cameraId ? { ...camera, targets } : camera,
      ),
    })),

  setTargets: (targets) => set({ targets }),
  setReason: (reason) => set({ reason }),
  focus: (cameraId) => set({ focused: cameraId }),
  reset: () => set(EMPTY),

  /**
   * Fill the draft from a stored zone.
   *
   * `nameEdited` is set true so the area picker cannot rewrite a name somebody
   * chose months ago the moment they touch the area field.
   *
   * Only ACTIVE bindings are loaded. A retired one is history -- the row is
   * kept so its overrides come back if the camera rejoins, but showing it as a
   * camera of the zone would invite somebody to "remove" what is already gone.
   */
  load: (zone) =>
    set({
      editing: zone.id,
      stage: "place",
      name: zone.name,
      nameEdited: true,
      kind: zone.kind,
      area: zone.area,
      reason: "",
      cameras: zone.cameras
        .filter((camera) => camera.active)
        .map((camera) => ({
          cameraId: camera.cameraId,
          // An unplaced camera carries the stock placeholder, which is not a
          // shape anybody chose -- so it loads as "not drawn" and the wizard
          // asks for it, rather than presenting the placeholder as done.
          shape: camera.placed
            ? {
                geometry: camera.geometry,
                points: camera.points,
                direction: camera.direction,
                confirmSeconds: camera.confirmSeconds,
              }
            : null,
          targets: camera.overrides.length > 0
            ? camera.overrides.map((t) => ({
                class: t.class,
                severity: t.severity,
                action: t.action,
              }))
            : null,
        })),
      targets: zone.targets.map((t) => ({
        class: t.class,
        severity: t.severity,
        action: t.action,
      })),
      focused: zone.cameras.find((camera) => camera.active)?.cameraId ?? null,
    }),
}));

/** Cameras still waiting to be drawn. Stage 2 is done when this is empty. */
export const undrawn = (cameras: DraftCamera[]) =>
  cameras.filter((camera) => camera.shape === null);
