export { BrowserRouter, type BrowserAdapter } from "./adapter.js";
export { createScoutCompanionAdapter, type CompanionAdapterOptions } from "./scout-companion.js";
export { createScoutNativeBrowserAdapter, type ScoutNativeBrowserOptions } from "./scout-native.js";
export { createScoutSafariAdapter, type ScoutSafariAdapterOptions } from "./scout-safari.js";
export { createBrowserUseAdapter, type BrowserUseAdapterOptions } from "./browser-use.js";

import { BrowserRouter } from "./adapter.js";
import { createBrowserUseAdapter } from "./browser-use.js";
import { createScoutCompanionAdapter } from "./scout-companion.js";
import { createScoutNativeBrowserAdapter } from "./scout-native.js";
import { createScoutSafariAdapter } from "./scout-safari.js";

/** Default Scout browser router: Companion (Chrome/Safari) -> Scout managed Chrome -> Safari -> browser-use CLI. */
export function createDefaultBrowserRouter(): BrowserRouter {
  return new BrowserRouter([
    createScoutCompanionAdapter(),
    createScoutNativeBrowserAdapter(),
    createScoutSafariAdapter(),
    createBrowserUseAdapter(),
  ]);
}
