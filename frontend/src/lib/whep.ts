/**
 * Live video, straight from the media hub.
 *
 * WHEP is the standardised "play a WebRTC stream" handshake: POST an SDP
 * offer, get an SDP answer, done. No signalling server, no library.
 *
 * WHY THE BACKEND IS NOT IN THIS PATH: video goes hub -> browser directly, so
 * detection load can never make the picture stutter, and the tile keeps
 * playing while the vision service or the edge node restarts. An operator who
 * can still watch the fence with their own eyes during a restart is a
 * meaningfully better failure than a black screen.
 *
 * WHY NOT RTSP: browsers cannot play it. There is no flag and no polyfill --
 * something has to repackage the stream, and WebRTC is the only transport
 * that arrives fast enough for a live security screen.
 *
 * H.264 ONLY: most browsers will not accept HEVC over WebRTC. Clips are
 * encoded H.264 by media/fetch.py and real cameras must be configured to it,
 * or the hub transcodes every stream and spends the CPU the detector needs.
 */

export type FeedState = "connecting" | "live" | "down";

export interface FeedHandle {
  close: () => void;
}

/** `${whepBase}/${streamPath}/whep` -- the hub path name is the camera id. */
export const whepUrl = (whepBase: string, streamPath: string) =>
  `${whepBase.replace(/\/$/, "")}/${streamPath}/whep`;

/**
 * Attach a hub stream to a <video> element.
 *
 * Returns a handle whose close() tears the peer connection down. Calling it is
 * not optional: an abandoned RTCPeerConnection keeps decoding, and a console
 * that mounts and unmounts tiles would accumulate live decoders until the tab
 * stops responding.
 */
export function playWhep(
  video: HTMLVideoElement,
  url: string,
  onState: (state: FeedState, detail?: string) => void,
): FeedHandle {
  let closed = false;
  let resource: string | null = null;

  const pc = new RTCPeerConnection({
    // No STUN. Console and hub are on the same LAN by design; a public STUN
    // server would be an internet dependency in a system whose whole claim is
    // that it does not have one. Off-site viewing needs STUN/TURN and is a
    // deliberate non-goal for now.
    iceServers: [],
  });

  // recvonly: the browser is a viewer. Without these the offer contains no
  // media sections and the hub answers with nothing to play.
  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (event) => {
    if (event.streams[0]) video.srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (closed) return;
    if (pc.connectionState === "connected") onState("live");
    if (pc.connectionState === "failed") {
      // Almost always ICE: the hub advertised an address the browser cannot
      // reach. On a Windows host that is usually a Hyper-V or WSL adapter
      // winning the candidate list -- IBVAP_MEDIA_ADVERTISE_IP settles it.
      onState("down", "no route to the media hub (check IBVAP_MEDIA_ADVERTISE_IP)");
    }
    if (pc.connectionState === "disconnected") onState("down", "stream dropped");
  };

  const negotiate = async () => {
    try {
      onState("connecting");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: offer.sdp ?? "",
      });

      if (!response.ok) {
        // 404 is the common one and it is not a bug in the console: the hub
        // has no such path, which means the clip is missing or its ffmpeg
        // publisher died. Say which, rather than "failed".
        onState(
          "down",
          response.status === 404
            ? "no such stream on the hub — is the clip present?"
            : `hub refused the stream (HTTP ${response.status})`,
        );
        return;
      }

      // The hub names a resource URL to DELETE on teardown. Without it the
      // session lingers server-side after the tab is gone.
      resource = response.headers.get("location");
      const answer = await response.text();
      if (closed) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      if (closed) return;
      onState("down", (error as Error).message);
    }
  };

  void negotiate();

  return {
    close: () => {
      closed = true;
      // Best effort, and deliberately not awaited: the tile is already gone
      // and the hub times the session out anyway.
      if (resource) void fetch(resource, { method: "DELETE" }).catch(() => {});
      video.srcObject = null;
      pc.close();
    },
  };
}
