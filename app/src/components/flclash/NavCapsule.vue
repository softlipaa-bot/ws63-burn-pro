<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { nextTabIndex } from "@/lib/keyboard-nav.js";

export type NavItem = {
  id: string;
  label: string;
  icon: string;
};

const props = withDefaults(
  defineProps<{
    items: NavItem[];
    modelValue: string;
    variant?: "rail" | "dock";
    /** When false, hide from a11y tree and omit canonical section-tab-* ids. */
    primary?: boolean;
  }>(),
  {
    variant: "rail",
    primary: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [id: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const indicator = ref({ left: 0, top: 0, width: 0, height: 0 });

const activeIndex = computed(() => {
  const idx = props.items.findIndex((item) => item.id === props.modelValue);
  return idx < 0 ? 0 : idx;
});

function tabId(id: string) {
  return props.primary ? `section-tab-${id}` : `section-tab-${props.variant}-${id}`;
}

function select(id: string) {
  if (id === props.modelValue) return;
  emit("update:modelValue", id);
}

async function syncIndicator() {
  await nextTick();
  const root = rootRef.value;
  if (!root) return;
  const btn = root.querySelector<HTMLElement>(".fl-nav-item.is-active");
  if (!btn) return;
  indicator.value = {
    left: btn.offsetLeft,
    top: btn.offsetTop,
    width: btn.offsetWidth,
    height: btn.offsetHeight,
  };
}

function onKeydown(event: KeyboardEvent) {
  if (!props.primary) return;
  const next = nextTabIndex(activeIndex.value, event.key, props.items.length);
  if (next == null) return;
  event.preventDefault();
  const id = props.items[next]?.id;
  if (!id) return;
  select(id);
  void nextTick(() => {
    document.getElementById(tabId(id))?.focus();
  });
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  void syncIndicator();
  if (typeof ResizeObserver !== "undefined" && rootRef.value) {
    resizeObserver = new ResizeObserver(() => {
      void syncIndicator();
    });
    resizeObserver.observe(rootRef.value);
  }
  window.addEventListener("resize", syncIndicator);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", syncIndicator);
});

watch(
  () => [props.modelValue, props.items, props.variant, props.primary] as const,
  () => {
    void syncIndicator();
  },
  { deep: true },
);
</script>

<template>
  <div
    ref="rootRef"
    class="fl-nav"
    :class="variant === 'dock' ? 'fl-nav--dock' : 'fl-nav--rail'"
    role="tablist"
    :aria-hidden="primary ? undefined : 'true'"
    :inert="!primary || undefined"
    @keydown="onKeydown"
  >
    <div
      class="fl-nav-indicator"
      aria-hidden="true"
      :style="{
        transform: `translate(${indicator.left}px, ${indicator.top}px)`,
        width: `${indicator.width}px`,
        height: `${indicator.height}px`,
      }"
    />
    <button
      v-for="item in items"
      :id="tabId(item.id)"
      :key="item.id"
      type="button"
      role="tab"
      class="fl-nav-item"
      :class="{ 'is-active': modelValue === item.id }"
      :aria-selected="modelValue === item.id"
      :aria-controls="`section-panel-${item.id}`"
      :tabindex="primary && modelValue === item.id ? 0 : -1"
      @click="select(item.id)"
    >
      <UIcon :name="item.icon" class="fl-nav-icon" />
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>
