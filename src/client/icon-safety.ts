/**
 * Safety predicate for extension-provided icon references.
 *
 * Only an embedded image data URL may reach an `<img>`: file paths, remote
 * URLs and non-image data URLs are rejected. Image decoding failures are
 * handled separately by ExtensionIcon's onError fallback.
 */
const SAFE_ICON = /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/iu

/** Validate an untrusted icon reference before it reaches an `<img>` element. */
export function isSafeIconDataUrl(value: string | undefined): value is string {
  return value !== undefined && SAFE_ICON.test(value.trim())
}
