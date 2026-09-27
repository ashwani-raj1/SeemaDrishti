"""
The one frame an operator needs to see.

STATUS: production-ready

WHY THIS EXISTS. A confirmed intrusion arrives at the console as numbers: a
class, a zone, a direction, a held time, a polygon. All of it true, none of it
answering the first question anybody actually asks, which is *what did it look
like*. Until now the console drew the geometry on graph paper, because there was
no picture to draw it on -- the frame that produced the event was discarded
microseconds after it was judged.

WHY IT IS CUT HERE AND NOT FETCHED LATER. This is the only process that ever
holds the frame. The node could pull a fresh picture from the media hub when the
console asks, but that is a picture of *now*, not of the moment -- a three-hour
old intrusion illustrated with an empty car park, which is worse than no picture
because it looks like evidence. A thumbnail has to be cut at confirm time or it
is not a thumbnail of the event.

WHY IT DOES NOT BREAK THE CPU BUDGET (section 3). It runs on CONFIRMED crossings
only -- seconds to minutes apart, not per frame -- and encodes a crop a few
hundred pixels wide, not the frame. The per-frame path is untouched. That is the
same argument as cascaded plate OCR: do the expensive thing on the small region,
after something cheap has decided it is worth doing.

WHY BASE64 IN THE EVENT and not a second upload. The durable channel already
retries with backoff and drains on shutdown. A separate upload would need its
own retry, its own failure mode, and would let an event arrive with a thumbnail
that never did -- two half-delivered halves of one fact. Riding inside the
payload means the picture is as delivered as the event is, or neither is.

SIZE IS THE WHOLE DESIGN CONSTRAINT. Section 8 promises "only events and
thumbnails sync upstream, never video" over a BOP's connectivity, so a thumbnail
that is not small is a broken promise. Capped at THUMB_WIDTH and JPEG quality
70, a crop lands around 8-20 KB -- roughly a tenth of a second of the video it
came from.
"""

import base64
from typing import Optional, Sequence

import cv2

# Wide enough to recognise a person against a fence, small enough that a day of
# events is megabytes rather than gigabytes. The console renders these at about
# 320 CSS px in the event list, so anything larger is paying to be downscaled.
THUMB_WIDTH = 384

# 70 is where JPEG stops being obviously lossy on this kind of content. Below
# about 60 the blocking artefacts start to look like detections.
JPEG_QUALITY = 70

# How much of the surroundings to keep, as a fraction of the box. A crop tight
# to the subject is unreadable: a person cut out of their background could be
# anywhere, and the whole point is to show WHERE they were. This keeps the fence
# line and some ground in the picture.
CONTEXT = 1.4

# Thumbnails are landscape because the frames are and the console lays them out
# that way. A tall crop of a standing person letterboxed into a wide box wastes
# most of the pixels on black.
ASPECT = 16 / 9


def crop_box(
    frame_w: int,
    frame_h: int,
    bbox_xywh: Sequence[float],
    context: float = CONTEXT,
    aspect: float = ASPECT,
) -> tuple[int, int, int, int]:
    """
    The pixel rectangle to cut, given a normalised [x, y, w, h] box.

    Separated from the encoding so it can be tested without an image: every
    interesting failure here is arithmetic (a box at the frame edge, a box
    taller than the frame, a degenerate zero-size box), and none of it needs
    OpenCV to go wrong.

    Returns (x1, y1, x2, y2) in pixels, always inside the frame and always at
    least one pixel in each direction.
    """
    x, y, w, h = (float(v) for v in bbox_xywh[:4])

    # Centre of the subject, in pixels.
    cx = (x + w / 2) * frame_w
    cy = (y + h / 2) * frame_h

    # Grow the box, then force the target aspect. Order matters: forcing aspect
    # first and then growing would grow the letterboxing too.
    cw = max(w * frame_w * context, 16.0)
    ch = max(h * frame_h * context, 16.0)
    if cw / ch < aspect:
        cw = ch * aspect
    else:
        ch = cw / aspect

    # A crop larger than the frame is not an error -- a subject filling the
    # picture is a legitimate close pass -- it just clamps to the whole frame.
    cw = min(cw, float(frame_w))
    ch = min(ch, float(frame_h))

    x1 = cx - cw / 2
    y1 = cy - ch / 2

    # Slide the window back inside the frame rather than clipping it, so a
    # subject at the edge still gets a full-size thumbnail instead of a sliver.
    x1 = max(0.0, min(x1, frame_w - cw))
    y1 = max(0.0, min(y1, frame_h - ch))

    return (
        int(round(x1)),
        int(round(y1)),
        int(round(x1 + cw)),
        int(round(y1 + ch)),
    )


def thumbnail_of(frame, bbox_xywh: Optional[Sequence[float]]) -> Optional[str]:
    """
    A base64 JPEG of the subject and its surroundings, or None.

    None on every failure path, deliberately and quietly: a missing picture must
    never cost the event it belongs to. An intrusion with no thumbnail is a
    smaller loss than an intrusion that was dropped because the encoder was
    unhappy, and the console already renders the geometry when there is no
    image. The caller does not branch -- it sets the field to whatever comes
    back.
    """
    if frame is None or bbox_xywh is None:
        return None

    try:
        frame_h, frame_w = frame.shape[:2]
        if frame_w <= 0 or frame_h <= 0:
            return None

        x1, y1, x2, y2 = crop_box(frame_w, frame_h, bbox_xywh)
        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            return None

        if crop.shape[1] > THUMB_WIDTH:
            scale = THUMB_WIDTH / crop.shape[1]
            crop = cv2.resize(
                crop,
                (THUMB_WIDTH, max(1, int(round(crop.shape[0] * scale)))),
                # AREA is the right filter for shrinking -- it averages the
                # pixels being thrown away instead of sampling one of them,
                # which is what stops a distant subject dissolving into noise.
                interpolation=cv2.INTER_AREA,
            )

        ok, buffer = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            return None

        return base64.b64encode(buffer.tobytes()).decode("ascii")
    except Exception:
        # Bare except on purpose. This runs inside the detection loop, and the
        # loop must survive anything a frame or an encoder can do to it.
        return None
