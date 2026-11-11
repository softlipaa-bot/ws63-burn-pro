<script setup lang="ts">
import { computed, onMounted, ref, unref } from "vue";
import {
  loadAppearanceOptional,
  type AppearanceApi,
  type AppearancePreference,
} from "./useAppearanceOptional";

const api = ref<AppearanceApi | null>(null);
const ready = ref(false);

const options: { id: AppearancePreference; label: string }[] = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
];

onMounted(async () => {
  api.value = await loadAppearanceOptional();
  ready.value = true;
});

const preference = computed(() => {
  const current = api.value;
  if (!current) return "system" as const;
  return unref(current.preference);
});

function setPreference(next: AppearancePreference) {
  api.value?.setPreference(next);
}
</script>

<template>
  <section class="fl-appear-card" aria-label="外观设置">
    <h2 class="fl-appear-title">外观</h2>
    <p class="fl-appear-desc">
      顶部按钮按当前显示主题立即切换浅/深；跟随系统请在此选择。
    </p>
    <div class="fl-appear-group" role="group" aria-label="外观偏好">
      <button
        v-for="opt in options"
        :key="opt.id"
        type="button"
        class="fl-appear-btn"
        :class="{ 'is-on': preference === opt.id }"
        :disabled="!api"
        :aria-pressed="preference === opt.id"
        @click="setPreference(opt.id)"
      >
        {{ opt.label }}
      </button>
    </div>
    <p v-if="ready && !api" class="fl-appear-desc" style="margin-top: 12px; margin-bottom: 0">
      主题模块尚未就绪（等待 DeepSeek appearance.ts / THEME-READY）。
    </p>
  </section>
</template>
