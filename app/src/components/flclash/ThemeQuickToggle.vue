<script setup lang="ts">
import { computed, onMounted, ref, unref } from "vue";
import {
  loadAppearanceOptional,
  type AppearanceApi,
} from "./useAppearanceOptional";

const api = ref<AppearanceApi | null>(null);
const ready = ref(false);

onMounted(async () => {
  api.value = await loadAppearanceOptional();
  ready.value = true;
});

const resolved = computed(() => {
  const current = api.value;
  if (!current) return "light" as const;
  return unref(current.resolved);
});
const label = computed(() =>
  resolved.value === "dark" ? "切换到浅色外观" : "切换到深色外观",
);
const icon = computed(() =>
  resolved.value === "dark" ? "i-lucide-sun" : "i-lucide-moon",
);

function onToggle() {
  api.value?.toggle();
}
</script>

<template>
  <button
    type="button"
    class="fl-theme-btn"
    :disabled="!api"
    :title="api ? label : '外观模块尚未就绪'"
    :aria-label="api ? label : '外观模块尚未就绪'"
    @click="onToggle"
  >
    <UIcon :name="api ? icon : 'i-lucide-palette'" class="fl-nav-icon" />
    <span class="fl-theme-label">{{ ready && !api ? "主题待接入" : "外观" }}</span>
  </button>
</template>

<style scoped>
@media (max-width: 520px) {
  .fl-theme-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
}
</style>
