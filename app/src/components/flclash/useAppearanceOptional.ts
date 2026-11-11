import { computed, ref, type ComputedRef, type Ref } from "vue";

export type AppearancePreference = "light" | "dark" | "system";

export type AppearanceApi = {
  preference: Ref<AppearancePreference>;
  resolved: ComputedRef<"light" | "dark">;
  toggle: () => void;
  setPreference: (next: AppearancePreference) => void;
};

type AppearanceModule = {
  useAppearance?: () => AppearanceApi;
  initializeAppearance?: () => void;
};

/** Vite-safe optional load: empty when DeepSeek module is not present yet. */
const appearanceLoaders = import.meta.glob<AppearanceModule>("../../lib/appearance.ts");

const ready = ref(false);
const missing = ref(true);
let api: AppearanceApi | null = null;
let loadPromise: Promise<AppearanceApi | null> | null = null;

export function appearanceModulePresent(): boolean {
  return Object.keys(appearanceLoaders).length > 0;
}

export async function loadAppearanceOptional(): Promise<AppearanceApi | null> {
  if (api) return api;
  if (loadPromise) return loadPromise;

  const entries = Object.entries(appearanceLoaders);
  if (!entries.length) {
    missing.value = true;
    ready.value = true;
    return null;
  }

  loadPromise = (async () => {
    try {
      const mod = await entries[0][1]();
      mod.initializeAppearance?.();
      if (typeof mod.useAppearance !== "function") {
        missing.value = true;
        ready.value = true;
        return null;
      }
      api = mod.useAppearance();
      missing.value = false;
      ready.value = true;
      return api;
    } catch {
      missing.value = true;
      ready.value = true;
      return null;
    }
  })();

  return loadPromise;
}

export function useAppearanceOptional() {
  void loadAppearanceOptional();

  return {
    ready: computed(() => ready.value),
    missing: computed(() => missing.value),
    get api() {
      return api;
    },
    async ensure() {
      return loadAppearanceOptional();
    },
  };
}
