import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * What the console remembers about THIS operator's seat.
 *
 * WHY THIS EXISTS AT ALL. Every one of these used to be a `useState` inside the
 * component that rendered the control, which meant a supervisor watching the
 * farm gate lost it by pressing F5, by walking to another service page and
 * back, or by following a link to an incident. On a screen somebody sits at for
 * a twelve-hour shift that is not a papercut; it is the console forgetting what
 * it was told, repeatedly, and it trained people not to trust it.
 *
 * WHY IT IS NOT IN `client/context.tsx`. That context holds what the NODE says:
 * the org, the site, the cameras, who is acting. It is refetched wholesale by
 * `refreshServer()` after every write. Seat state is the opposite kind of thing
 * -- it is this browser's, it is never sent anywhere, and it must survive
 * exactly the refresh that throws the server state away. Mixing the two would
 * mean every camera-list refresh re-renders every screen that merely remembers
 * a dropdown, and a `refreshServer()` would be one careless line away from
 * clearing the selection.
 *
 * WHY PERSISTED, AND WHERE. `localStorage`, per browser, keyed by device rather
 * than by user. This is deliberately NOT part of the record: nothing here is
 * audited, nothing here changes what the detector does, and a shared post
 * terminal remembering the last camera is a convenience, not a claim about who
 * did what. Anything that IS a decision goes to the node with a reason.
 *
 * REHYDRATION IS ASYNCHRONOUS-ISH. On the first render `localStorage` has not
 * been read yet, so a selection read here can briefly be the default. Every
 * consumer already handles "nothing selected" (it is the state on a fresh
 * install), so this shows up as one frame of the fallback, never as a wrong
 * camera.
 */

interface ConsoleState {
  /**
   * The camera each service page is looking at, keyed by module.
   *
   * Per module, not one shared value: fence and ANPR run on different cameras
   * (`media/cameras.yml` enables ANPR only at the gate), so carrying one
   * selection across both would keep landing a supervisor on a camera the page
   * they just opened cannot say anything about.
   */
  cameraByModule: Record<string, string>;
  setCameraFor: (module: string, cameraId: string) => void;

  /**
   * The zone filter in the command header, or null for "all zones".
   *
   * A zone ID, not a name -- names are editable, and a filter that silently
   * stops matching because somebody renamed a zone is a filter that lies.
   */
  zoneFilter: string | null;
  setZoneFilter: (zoneId: string | null) => void;
}

export const useConsoleStore = create<ConsoleState>()(
  persist(
    (set) => ({
      cameraByModule: {},
      setCameraFor: (module, cameraId) =>
        set((state) => ({
          cameraByModule: { ...state.cameraByModule, [module]: cameraId },
        })),

      zoneFilter: null,
      setZoneFilter: (zoneId) => set({ zoneFilter: zoneId }),
    }),
    {
      name: "ibvap.console",
      version: 1,
      // Named explicitly so a future field can be added without it being
      // persisted by accident. Anything holding a node response (an incident,
      // a camera list) must NOT go in here -- it would come back from
      // localStorage looking current after being wrong for a week.
      partialize: (state) => ({
        cameraByModule: state.cameraByModule,
        zoneFilter: state.zoneFilter,
      }),
    },
  ),
);

/**
 * The remembered camera for a module, if it is still one of the offered ones.
 *
 * The check is the point. A remembered id can name a camera that has since been
 * deleted, renamed out of the hub, or taken out of service, and a dropdown
 * whose value matches no option renders blank with no explanation. Falling back
 * is silent and correct; the caller then picks a default as it always did.
 */
export function rememberedCamera(
  cameraByModule: Record<string, string>,
  module: string,
  available: ReadonlyArray<{ id: string }>,
): string | null {
  const remembered = cameraByModule[module];
  if (!remembered) return null;
  return available.some((camera) => camera.id === remembered) ? remembered : null;
}
