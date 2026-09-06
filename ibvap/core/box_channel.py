"""
The hot path: raw detections pushed to the console for the live overlay.

WHY THIS IS A SEPARATE CHANNEL FROM THE INGRESS POST (core/ingress_client.py):
the two carry the same detections to different places for different reasons,
at different rates, with opposite durability.

    ingress POST  -> backend  -> fence -> events -> SQLite   durable, ~/minute
    this WS       -> browser  -> a rectangle on a screen     ephemeral, ~/frame

Boxes are never stored. At four cameras, three subjects and a few frames a
second this channel is on the order of a hundred detections a second; writing
that anywhere durable would dwarf the event log by orders of magnitude and
destroy the property that keeps the database small enough to live at a remote
post. The moment nobody is looking at the tile, a box is worthless. What
survives is what the fence decided about it, which the backend already stores.

WHY NOT MUX BOXES INTO THE VIDEO: burning rectangles into frames server-side
would put this process in the video path, force a re-encode per camera, and
turn a slow detector into stuttering video instead of late boxes. Keeping the
channels apart means the worst a slow model can do is draw late.

WHY ONE SOCKET, MULTIPLEXED BY camera_id: browsers cap concurrent connections
per host, and a console showing four tiles would otherwise hold four sockets
to the same process for no gain. Clients filter by camera_id, or narrow the
server side with a subscribe message when many cameras exist.

STATUS: prototype.
"""

import asyncio
import json
import threading
import time

import websockets
from websockets.asyncio.server import serve


class _Client:
    """
    One connected browser.

    A queue of ONE, drop-oldest: a console on a slow link must never apply
    backpressure to the detection loop, and a stale box is worse than no box.
    Same latest-wins policy core/ingest.py uses for live sources and
    core/ingress_client.py uses for the backend post — one rule, three places.
    """

    __slots__ = ("ws", "cameras", "queue", "dropped")

    def __init__(self, ws):
        self.ws = ws
        self.cameras = None          # None = every camera
        self.queue = asyncio.Queue(maxsize=1)
        self.dropped = 0

    def wants(self, camera_id):
        return self.cameras is None or camera_id in self.cameras

    def offer(self, message):
        if not self.wants(message["camera_id"]):
            return
        if self.queue.full():
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            pass


class BoxChannel:
    """
    A WebSocket server on its own asyncio loop in its own thread.

    The detection loops are plain blocking threads (they are dominated by a
    synchronous YOLO call, so making them async would buy nothing). This gives
    them a `publish()` they can call without knowing asyncio exists.
    """

    def __init__(self, bind="0.0.0.0", port=8100):
        self.bind = bind
        self.port = port
        self.sent = 0
        self._clients = set()
        self._loop = None
        self._thread = None
        self._ready = threading.Event()
        self._stopping = False
        # Created inside the loop. Shutdown sets it rather than calling
        # loop.stop(), so `async with serve(...)` gets to unwind normally --
        # stopping the loop out from under it leaves the server trying to
        # schedule its own close on a loop that is already gone.
        self._shutdown = None

    # ── public, called from worker threads ───────────────────────────────

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        # Wait for the loop to exist, so a publish() immediately after start()
        # is not silently dropped.
        self._ready.wait(timeout=5.0)
        return self

    def publish(self, camera_id, boxes, capture_mono):
        """
        Non-blocking, thread-safe. Safe to call at full frame rate.

        Sends even when `boxes` is empty: an empty list is how the overlay
        learns a person LEFT. Skipping empties would leave the last box frozen
        on screen after the frame emptied, which reads as a stuck detector.
        """
        if self._loop is None or self._stopping:
            return
        message = {
            "t": "boxes",
            "camera_id": camera_id,
            "capture_mono": round(capture_mono, 3),
            "boxes": boxes,
        }
        try:
            self._loop.call_soon_threadsafe(self._fanout, message)
        except RuntimeError:
            pass  # loop closed underneath us during shutdown

    def stats(self):
        return {
            "clients": len(self._clients),
            "sent": self.sent,
            "dropped": sum(c.dropped for c in self._clients),
        }

    def stop(self):
        self._stopping = True
        if self._loop is not None and self._shutdown is not None:
            try:
                self._loop.call_soon_threadsafe(self._shutdown.set)
            except RuntimeError:
                pass
        if self._thread:
            self._thread.join(timeout=2.0)

    # ── loop side ────────────────────────────────────────────────────────

    def _fanout(self, message):
        for client in self._clients:
            client.offer(message)

    def _run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        except Exception as e:                       # noqa: BLE001
            print(f"[boxes] server stopped: {e}")
        finally:
            self._loop.close()

    async def _serve(self):
        self._shutdown = asyncio.Event()
        async with serve(self._handle, self.bind, self.port,
                         ping_interval=20, ping_timeout=20):
            print(f"[boxes] ws://{self.bind}:{self.port} — live overlay channel")
            self._ready.set()
            await self._shutdown.wait()

    async def _handle(self, ws):
        client = _Client(ws)
        self._clients.add(client)
        try:
            await ws.send(json.dumps({
                "t": "hello",
                "at": time.time(),
                "note": "boxes are ephemeral; the durable record is the "
                        "backend's SSE stream",
            }))
            # One task drains the queue outward, one reads control messages in.
            await asyncio.gather(
                self._pump(client),
                self._control(client),
            )
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:                       # noqa: BLE001
            print(f"[boxes] client error: {e}")
        finally:
            self._clients.discard(client)

    async def _pump(self, client):
        while True:
            message = await client.queue.get()
            await client.ws.send(json.dumps(message))
            self.sent += 1

    async def _control(self, client):
        """
        Subscription control. The one thing a WebSocket gives us that a second
        SSE stream would not: a console showing one tile fullscreen can stop
        paying for the other cameras' boxes.
        """
        async for raw in client.ws:
            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                continue
            kind = message.get("t")
            names = message.get("cameras") or []
            if kind == "subscribe":
                client.cameras = set(names) if names else None
            elif kind == "unsubscribe":
                if client.cameras is None:
                    continue
                client.cameras -= set(names)
