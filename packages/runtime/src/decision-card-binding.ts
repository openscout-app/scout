import {
  DecisionCardError,
  validateDecisionCard,
  type AttachmentUpload,
  type DecisionCard,
  type DecisionCardSubmission,
} from "@openscout/protocol";

/** The attachment id of a card's picture on the ask's message. */
export function decisionPictureAttachmentId(messageId: string, image: number): string {
  return `${messageId}.decision.${image}`;
}

/**
 * Width and height from the image's own header: PNG, GIF, JPEG or WebP.
 * Returns null for anything it cannot read.
 */
export function imagePixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
    if (chunk === "VP8 " && bytes.length >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const length = view.getUint16(at + 2);
      // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      at += 2 + length;
    }
  }
  return null;
}

/**
 * Turn an agent's submission into the stored card. Each picture becomes a
 * reference to an attachment on the ask's message, with the size read from the
 * image bytes. The bytes themselves are bound by the attachment service.
 */
export function bindDecisionCard(
  submission: DecisionCardSubmission,
  messageId: string,
  images: readonly AttachmentUpload[],
): DecisionCard {
  const options = submission.options.map((option) => {
    const { picture, ...rest } = option;
    if (!picture) return rest;
    const upload = images[picture.image];
    if (!upload) throw new DecisionCardError([`decision.options.${option.key}.picture.image: no image ${picture.image} on the request`]);
    const size = imagePixelSize(Buffer.from(upload.data, "base64"));
    if (!size || size.width <= 0 || size.height <= 0) {
      throw new DecisionCardError([`decision.options.${option.key}.picture: cannot read the size of ${upload.fileName ?? "the image"}`]);
    }
    return { ...rest, picture: {
      attachmentId: decisionPictureAttachmentId(messageId, picture.image),
      width: size.width,
      height: size.height,
      ...(picture.callouts?.length ? { callouts: picture.callouts } : {}),
    } };
  });
  const card: DecisionCard = { ...submission, kind: "decision", options };
  const problems = validateDecisionCard(card, { origin: "agent", pictures: "attachment" });
  if (problems.length) throw new DecisionCardError(problems);
  return card;
}
