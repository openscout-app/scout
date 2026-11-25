export { BrowserRouter, type BrowserAdapter } from "./adapter.js";
export { createScoutCompanionAdapter, type CompanionAdapterOptions } from "./scout-companion.js";
export { createScoutNativeBrowserAdapter, type ScoutNativeBrowserOptions } from "./scout-native.js";
export { createBrowserUseAdapter, type BrowserUseAdapterOptions } from "./browser-use.js";

import { BrowserRouter } from "./adapter.js";
import { createBrowserUseAdapter } from "./browser-use.js";
import { createScoutCompanionAdapter } from "./scout-companion.js";
import { createScoutNativeBrowserAdapter } from "./scout-native.js";

/** Default Scout browser router: Chrome Companion -> Scout managed Chrome -> browser-use CLI. */
export function createDefaultBrowserRouter(): BrowserRouter {
  return new BrowserRouter([
    createScoutCompanionAdapter(),
    createScoutNativeBrowserAdapter(),
    createBrowserUseAdapter(),
  ]);
}
