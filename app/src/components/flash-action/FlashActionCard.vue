<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import "./flash-action.css";

defineProps<{
  state: string;
  statusLabel: string;
  detail: string;
  targetLabel: string;
  actionLabel: string;
  active: boolean;
  canStart: boolean;
  progress: number | null;
}>();
defineEmits<{ activate: [] }>();

const foreground = ref(true);
function visibilityChanged() { foreground.value = !document.hidden && document.hasFocus(); }
function focused() { foreground.value = !document.hidden; }
function blurred() { foreground.value = false; }
onMounted(() => {
  visibilityChanged();
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("focus", focused);
  window.addEventListener("blur", blurred);
});
onUnmounted(() => {
  document.removeEventListener("visibilitychange", visibilityChanged);
  window.removeEventListener("focus", focused);
  window.removeEventListener("blur", blurred);
});
</script>

<template>
  <section
    class="flash-action-card"
    data-testid="flash-action-card"
    :data-state="state"
    :class="{ 'is-active': active, 'is-paused': !foreground }"
    aria-label="烧录控制"
  >
    <svg class="action-wave" viewBox="0 0 330 240" preserveAspectRatio="none" aria-hidden="true">
      <path d="M106-20H350V258C304 230 302 199 266 215C229 232 215 214 197 211C176 207 161 219 146 204C130 189 139 165 119 151C98 136 91 124 100 103C111 77 84 72 88 49C93 24 116 18 106-20Z" />
      <path class="action-wave-echo" d="M171-20H350V258C318 231 308 187 275 197C248 204 242 187 222 184C205 182 194 192 181 177C167 161 179 139 161 123C143 107 142 94 151 77C163 56 140 38 150 18C154 9 165 1 171-20Z" />
    </svg>

    <div class="action-copy">
      <div class="action-eyebrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="m6 12 3-1 2 4 3-7 2 4h2"/></svg>
        <span>烧录状态</span>
        <span class="action-badge">{{ active ? '进行中' : state === 'idle' ? '未运行' : '已结束' }}</span>
      </div>
      <h2 class="action-headline" aria-live="polite">{{ statusLabel }}</h2>
      <p class="action-detail" :title="detail">{{ detail }}</p>
      <div class="action-facts">
        <span>{{ targetLabel }}</span>
        <span v-if="progress !== null" class="action-progress">进度 <strong>{{ progress }}<small>%</small></strong></span>
        <span v-else class="action-hint">{{ active ? '随时可以停止' : canStart ? '配置就绪' : '选择固件和串口后开始' }}</span>
      </div>
    </div>

    <div class="action-control">
      <div class="action-orbit">
        <span v-if="active" class="action-ring" aria-hidden="true" />
        <button
          type="button"
          class="action-button"
          data-testid="flash-action-button"
          :class="{ 'is-stop': active }"
          :disabled="!active && !canStart"
          :aria-label="active ? '停止烧录' : actionLabel"
          :title="active ? '停止当前烧录任务（Esc）' : canStart ? actionLabel : '请先完成固件和串口配置'"
          @click="$emit('activate')"
        >
          <svg class="action-glyph action-play" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M11 7.9c0-1.5 1.6-2.4 2.9-1.6l12.3 8.1c1.1.7 1.1 2.5 0 3.2l-12.3 8.1c-1.3.8-2.9-.1-2.9-1.6Z" /></svg>
          <svg class="action-glyph action-stop" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><rect x="8" y="8" width="16" height="16" rx="3" /></svg>
        </button>
      </div>
      <span class="action-button-label">{{ active ? '停止烧录' : actionLabel }}</span>
    </div>
  </section>
</template>
