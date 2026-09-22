"""
The two sinks. One process, two exits, opposite guarantees.

    LiveChannel   WebSocket fanout   drop freely, never retry, never store
    DurableSink   HTTP POST          retry with backoff, never drop silently

WHY THE POLICIES ARE OPPOSITE: a live box is worthless the moment it is late —
by the time it arrives the subject has moved and the rectangle is simply wrong,
so holding one for a slow console makes the overlay worse, not better. A
confirmed intrusion is the opposite: it is worth exactly as much five seconds
late as it was when it happened, and losing one means the record disagrees with
what occurred. Same process, same detections, two completely different answers
to "what do we do when the far end is slow".

Neither sink may ever block the detection loop. The live path drops; the
durable path queues and retries on its own task. A backend that is down slows
nothing here — it shows up as a rising `failed` count in the run summary.

STATUS: prototype.
"""

import asyncio
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import websockets
from websockets.asyncio.server import serve

from core.payload import DurableEvent, LiveObservation


class _Client:
    """
    One connected console.

    A queue of ONE, drop-oldest: a browser on a slow link must never apply
    backpressure to the detection loop, and a stale box is worse than no box.
    The same latest-wins rule core/capture.py uses for live sources — one
    policy, applied everywhere it applies.
    """

    __slots__ = ("ws", "cameras", "pending", "status", "wake", "dropped")

    def __init__(self, ws):
        self.ws = ws
        self.cameras: set[str] | None = None  # None = every camera
        # LATEST-WINS PER (camera, module), NOT PER CLIENT. This was a single
        # slot, which was correct when the channel carried one message per
        # frame. It no longer does: every module publishes its own view of the
        # same frame, back to back in one tick. With one slot the last module
        # to publish overwrote all the others EVERY time -- not occasionally,
        # deterministically -- so the fence and ANPR pages received nothing at
        # all while multi_human (last in the list) looked fine. Keying by
        # stream keeps the drop-oldest policy where it belongs: a stale fence
        # box is replaced by a fresher fence box, never by an ANPR one.
        self.pending: dict[str, dict] = {}
        # Service-level messages ride a SEPARATE queue. They are low-rate and
        # must not be dropped, but observations are deliberately drop-oldest --
        # sharing one lane would let a busy camera at 6/s discard the one
        # message that says the detector is alive.
        self.status: asyncio.Queue = asyncio.Queue(maxsize=8)
        self.wake = asyncio.Event()
        self.dropped = 0

    def wants(self, camera_id: str) -> bool:
        return self.cameras is None or camera_id in self.cameras

    def offer(self, message: dict) -> None:
        if not self.wants(message.get("camera_id", "")):
            return
        key = f'{message.get("camera_id")}/{message.get("module")}'
        if key in self.pending:
            self.dropped += 1  # a fresher frame for this same stream
        self.pending[key] = message
        self.wake.set()


class LiveChannel:
    """
    The hot path: one WebSocket server, multiplexed by camera_id.

    ONE SOCKET, NOT ONE PER CAMERA: browsers cap concurrent connections per
    host, and a console showing four tiles would otherwise hold four sockets to
    the same process for no gain. Clients filter on camera_id, or narrow the
    server side with a `subscribe` message when there are many cameras.

    NOT MUXED INTO THE VIDEO: burning rectangles into frames server-side would
    put this process in the video path and force a re-encode per camera, so a
    slow detector would produce stuttering video instead of late boxes. Keeping
    the channels apart means the worst a slow model can do is draw late.
    """

    def __init__(self, bind="0.0.0.0", port=8100):
        self.bind = bind
        self.port = port
        self.sent = 0
        self._dropped_total = 0
        self._clients: set[_Client] = set()
        self._server = None

    def publish(self, message: dict) -> None:
        """Non-blocking fanout. Safe to call at full cadence."""
        for client in self._clients:
            client.offer(message)

    def publish_observation(self, observation: LiveObservation) -> None:
        self.publish(observation.to_dict())

    def broadcast(self, message: dict) -> None:
        """
        A service-level message, to every client regardless of subscription.

        A console watching one camera still needs to know the detector is up --
        that is a fact about the process, not about a camera, so it is not
        subject to camera filtering.
        """
        for client in self._clients:
            try:
                client.status.put_nowait(message)
                client.wake.set()
            except asyncio.QueueFull:
                pass

    async def serve_forever(self, stop: asyncio.Event) -> None:
        async with serve(self._handle, self.bind, self.port,
                         ping_interval=20, ping_timeout=20) as server:
            self._server = server
            print(f"[live] ws://{self.bind}:{self.port} - live observation channel")
            await stop.wait()
            # MUST close before leaving the block. `serve()`'s __aexit__ awaits
            # wait_closed(), which blocks forever on a server nobody closed --
            # so without this the task only ever ends by being cancelled, and a
            # caller that politely awaits it hangs instead.
            server.close()

    async def _handle(self, ws) -> None:
        client = _Client(ws)
        self._clients.add(client)
        try:
            await ws.send(json.dumps({
                "t": "hello",
                "at": time.time(),
                "note": "live observations are ephemeral; the durable record "
                        "arrives from the edge node, not from here",
            }))
            # RACE, do not gather. `_pump` waits on a queue that may never fill
            # again, so gather() would wait for it forever after `_control`
            # ends at disconnect -- leaking a task and leaving the client in
            # `_clients`, where publish() keeps feeding a socket nobody is
            # reading. A console left open all shift, reloaded a few times,
            # would accumulate dead clients until the process was restarted.
            # First one to finish wins; the other is cancelled.
            pump = asyncio.create_task(self._pump(client))
            control = asyncio.create_task(self._control(client))
            done, pending = await asyncio.wait(
                {pump, control}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()  # re-raise, so a real error is not swallowed
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception as error:  # noqa: BLE001
            print(f"[live] client error: {error}")
        finally:
            # Keep the count after a browser disconnects, or a busy tab closing
            # makes the run summary falsely report zero drops.
            self._dropped_total += client.dropped
            self._clients.discard(client)

    async def _pump(self, client: _Client) -> None:
        """
        Drain everything waiting, status first.

        One wake-up drains every pending stream rather than one message, so N
        modules on N cameras all get through on the same tick. Status is sent
        before observations because it is rare and load-bearing: it is what
        separates a quiet scene from a dead detector.
        """
        while True:
            await client.wake.wait()
            # Cleared BEFORE draining: anything offered while we are sending
            # sets it again and is picked up on the next pass, rather than
            # being silently swallowed by a clear that came after.
            client.wake.clear()

            while not client.status.empty():
                await client.ws.send(json.dumps(client.status.get_nowait()))

            for key in list(client.pending):
                message = client.pending.pop(key, None)
                if message is None:
                    continue
                await client.ws.send(json.dumps(message))
                self.sent += 1

    async def _control(self, client: _Client) -> None:
        """A console showing one tile fullscreen can stop paying for the rest."""
        async for raw in client.ws:
            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                continue
            names = set(message.get("cameras") or [])
            if message.get("t") == "subscribe":
                client.cameras = names or None
            elif message.get("t") == "unsubscribe" and client.cameras is not None:
                client.cameras -= names

    def stats(self) -> dict:
        return {
            "clients": len(self._clients),
            "sent": self.sent,
            "dropped": self._dropped_total + sum(c.dropped for c in self._clients),
        }


class DurableSink:
    """
    The cold path: confirmed events to the edge node's ingress.

    WHY urllib AND NOT aiohttp/httpx: one POST every few seconds does not
    justify a dependency, and every dependency is a laptop that fails to set up
    the night before submission. The blocking call runs in a worker thread via
    asyncio.to_thread, so the event loop is never held by a socket — which is
    the only property that actually matters here. Measured on Windows, a single
    failed connect to a closed port takes ~2 s despite a 1 s socket timeout;
    inline, that would have cost the detection loop 2 s per attempt.

    RETRY, NOT DROP: the live path may lose data by design. This one may not.
    Attempts back off, and an event that exhausts them is counted and named in
    the run summary rather than disappearing quietly.
    """

    def __init__(self, base_url: str, source_id: str, timeout=3.0,
                 queue_size=512, attempts=4):
        self.url = base_url.rstrip("/") + "/hooks/ingress/events"
        self.source_id = source_id
        self.timeout = timeout
        self.attempts = attempts
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=queue_size)

        self.sent = 0
        self.failed = 0
        self.shed = 0
        self._warned = False

    def submit(self, event: DurableEvent, simulated: bool) -> None:
        """
        Non-blocking. Called from the detection loop.

        A full queue means the node has been unreachable long enough to bank
        512 events. Shedding the NEWEST rather than blocking is the lesser
        harm — stalling the loop would stop detection on a live camera, which
        loses far more than one event — and the count is reported honestly.
        """
        payload = event.to_dict()
        payload["source_id"] = self.source_id
        payload["simulated"] = simulated
        payload["occurred_at"] = datetime.now(timezone.utc) \
            .isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            self.queue.put_nowait(payload)
        except asyncio.QueueFull:
            self.shed += 1

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                payload = await asyncio.wait_for(self.queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            await self._deliver(payload)

        # Drain what is already confirmed before the process exits. These are
        # facts that happened; losing them on shutdown would be the one silent
        # data loss this whole split exists to prevent.
        while not self.queue.empty():
            await self._deliver(self.queue.get_nowait())

    async def _deliver(self, payload: dict) -> None:
        for attempt in range(1, self.attempts + 1):
            try:
                await asyncio.to_thread(self._post, payload)
                self.sent += 1
                return
            except Exception as error:  # noqa: BLE001
                if attempt == self.attempts:
                    self.failed += 1
                    if not self._warned:
                        print(f"[durable] node unreachable at {self.url}: {error}\n"
                              f"          continuing; the run summary reports "
                              f"total failures.")
                        self._warned = True
                    return
                await asyncio.sleep(min(0.5 * 2 ** (attempt - 1), 5.0))

    def _post(self, payload: dict) -> None:
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
        except urllib.error.HTTPError as error:
            # Bare `str(error)` is just "HTTP Error 400: Bad Request" -- the
            # reason PHRASE, not the reason. The node's BadRequest handler
            # puts the actual validation message in the response body, and
            # without it "the node rejected something" is where diagnosis
            # stops. Re-raised with the body attached so _deliver's log line
            # says what was actually wrong with the payload.
            detail = error.read().decode("utf-8", errors="replace")
            raise urllib.error.HTTPError(
                error.url, error.code, f"{error.reason} -- {detail}",
                error.headers, error.fp) from None

    def stats(self) -> dict:
        return {"sent": self.sent, "failed": self.failed,
                "shed": self.shed, "queued": self.queue.qsize()}


class Dispatcher:
    """
    What a module's two return lists are handed to.

    The only place that knows a module produced something. Modules name no
    transport; transports name no module. That is what lets a new module be
    added without touching this file.
    """

    def __init__(self, live: LiveChannel, durable: DurableSink | None):
        self.live = live
        self.durable = durable

    def dispatch(self, camera_id: str, module: str, frame_ts: float,
                 live_items: list[dict], durable_items: list[dict],
                 simulated: bool) -> None:
        # PUBLISHED EVEN WHEN EMPTY, and this is not an oversight to optimise
        # away. An empty track list is how the overlay learns a subject LEFT;
        # skipping empties freezes the last box on screen after the frame
        # cleared, which reads as a stuck detector. It is also the only signal
        # that separates "running, nothing in view" from "process is dead" --
        # a quiet border and a crashed detector look identical otherwise, and
        # that is the exact failure this console exists to prevent.
        self.live.publish_observation(LiveObservation(
            camera_id=camera_id, module=module,
            frame_ts=frame_ts, tracks=live_items,
        ))
        if not self.durable:
            return
        for item in durable_items:
            self.durable.submit(DurableEvent(
                camera_id=camera_id,
                module=module,
                event_type=item["event_type"],
                track_id=item.get("track_id"),
                data=item.get("data") or {},
                timestamp=frame_ts,
            ), simulated=simulated)
