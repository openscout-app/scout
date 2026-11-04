# Operator image attachments

`scout ask --operator --fyi --notify --image <path> "<text>"` submits news
with one image and requests a push. Task asks and replies also accept `--image`.
The runtime chooses the operator DM and records one message with a canonical
blob reference. No pairing store, web cookie, file-server URL, or app package
participates in this write.

The CLI ask/reply path uses versioned task delivery and the canonical attachment
writer. The older operator upload route below remains a supported transport API;
removing CLI verbs does not remove runtime routes.

## Local write contract

`POST /v1/operator/notify-with-attachment` accepts this strict JSON shape:

```json
{
  "actorId": "agent-id",
  "requestId": "caller-owned-id",
  "body": "Ready for review",
  "attachment": {
    "data": "canonical base64 bytes",
    "mediaType": "image/png",
    "fileName": "screen.png"
  }
}
```

`fileName` is optional. It must contain at most 200 characters and no path
separator or control character. The runtime accepts PNG, JPEG, GIF and WebP,
checks their magic bytes, and limits decoded bytes to 25 MiB. The JSON request
limit is normally 36 MiB. Protected local ingress currently limits requests
to 16 MiB, including base64 overhead. The existing
`GET /v1/attachments/capability` exposes the effective `requestBytes` limit.
The runtime rejects oversize requests; it does not clip an image.

The route requires verified local transport and a locally authorized actor.
Remote, peer, guest, scoped, origin-bearing and forwarded requests are refused.
A mesh control grant does not authorize this operation. Local actor selection
retains Scout's high-trust local model; this is not a new per-agent
credential boundary. The CLI uses ordinary explicit, environment and project
sender resolution, then the existing identity-scoped broker registration path.

The body cannot select a conversation, node or recipient. It cannot contain a
reply ID, question, permission, work item, arbitrary metadata, URL, blob hash
or pairing key. The runtime sets `operatorSignal` to
`{kind:"notify",blocking:false,replyExpectation:"none"}`. It preserves the
sender return address and queues the existing best-effort operator signal
after a new canonical commit. A duplicate request does not enqueue it again.
The question and permission commands and their answer guards are unchanged.
An image notification cannot answer an existing question.

## Recording, retry and reads

Success returns HTTP 200 with `{ok:true,message,duplicate}`. The message ID is
`msg.request.` plus SHA-256 of `JSON.stringify([actorId,requestId])`. The
attachment has a typed `blob` containing SHA-256, media type and byte size,
not inline bytes, a URL or a pairing-store key. The CLI checks this receipt
against its submitted sender, request, text and image.

The existing attachment service syncs bytes before canonical message admission.
It rechecks actor authority, conversation membership and the fixed operator DM
at admission. A failed commit can leave an unbound file for existing grace/GC
handling, but cannot make it readable through a message. Journal replay keeps
the reference, not the bytes. Existing authorized attachment reads require
current membership and the current message binding before and after file IO.

The same actor/request ID with identical content is idempotent while the
message remains retained. A different binding, content or notification mode
returns a conflict. The CLI generates a fresh request ID per invocation and
never retries a write automatically. A transport failure or invalid receipt
can leave recording unconfirmed. Do not repeat an ambiguous invocation blindly;
inspect broker history first. A selected Unix socket never falls back to TCP
for the image write. Redirects and ambient cookies are disabled.

The receipt says `status: "recorded"` and
`notificationDelivery: "unconfirmed"`. It proves neither push delivery nor
reading. `imageExpiresAt` is `null`: the old pairing-store six-hour expiry no
longer applies. Blob retention and message retention determine availability;
this is not a permanent-storage guarantee. An unavailable or older runtime fails
without a legacy write fallback. Text-only notifications keep their existing
broker delivery path.

A reading client must understand typed blob references and the authorized
attachment read API. This write contract does not establish that a particular
phone or desktop client can display the image. Remote push contains generic
text and opaque message references, never image bytes.
