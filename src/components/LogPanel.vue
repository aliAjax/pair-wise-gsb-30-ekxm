<script setup lang="ts">
import { useDispatchStore } from "../store";
import { formatTime } from "../utils";

const store = useDispatchStore();

const levelClass: Record<string, string> = {
  info: "log-info",
  warn: "log-warn",
  ok: "log-ok"
};
const levelDot: Record<string, string> = {
  info: "#176b87",
  warn: "#d98a1f",
  ok: "#14724f"
};
</script>

<template>
  <section class="list-panel log-panel">
    <div class="toolbar">
      <h2>调度动态</h2>
      <span class="muted">替代群消息拼库存：分配、退回、送达、超时回收全程留痕</span>
    </div>
    <div v-if="store.logs.length === 0" class="empty">暂无动态</div>
    <ul v-else class="log-list">
      <li v-for="log in store.logs" :key="log.id" class="log-item">
        <span class="log-dot" :style="{ background: levelDot[log.level] }" />
        <div>
          <p class="log-message" :class="levelClass[log.level]">{{ log.message }}</p>
          <span class="muted small">{{ formatTime(log.createdAt) }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>
