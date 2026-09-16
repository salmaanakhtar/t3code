/**
 * Search parameters a popout window carries.
 *
 * Kept in a leaf module with no imports of its own: stores that must not share
 * persisted state across windows need to read these — the panel store, for one —
 * without importing the module that itself depends on those stores, which would
 * be an import cycle.
 */
export const POPOUT_KEY_PARAM = "popout";
export const POPOUT_KIND_PARAM = "popoutKind";
export const POPOUT_SURFACE_PARAM = "popoutSurface";

/** True in a renderer that is a panel moved into its own window. */
export function isPopoutRenderer(search?: string): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(search ?? window.location.search);
  return params.has(POPOUT_KEY_PARAM);
}
