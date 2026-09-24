<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useDispatchStore } from "./store";
import StationPanel from "./components/StationPanel.vue";
import DispatchPanel from "./components/DispatchPanel.vue";
import PlanPanel from "./components/PlanPanel.vue";
import LogPanel from "./components/LogPanel.vue";

const store = useDispatchStore();

const tabs = [
  { key: "dispatch", label: "调度分配" },
  { key: "stations", label: "油站需求" },
  { key: "plans", label: "车辆与计划" },
  { key: "logs", label: "调度动态" }
] as const;

const activeTab = ref<(typeof tabs)[number]["key"]>("dispatch");

const metricCards = computed(() => [
  { label: "总缺口 / 待分配", value: `${store.metrics.openGap} 吨`, sub: `总缺口 ${store.metrics.totalGap} 吨` },
  { label: "占用中（在途）", value: `${store.metrics.activeTons} 吨`, sub: `${store.metrics.activeCount} 笔分配` },
  { label: "待发车可分配额度", value: `${store.metrics.availableTons} 吨`, sub: "已发车/到站不占用" },
  { label: "已送达核减", value: `${store.metrics.deliveredTons} 吨`, sub: `退回留痕 ${store.metrics.shortRejections} 笔` }
]);

// 持久化
watch(
  () => [store.stations, store.vehicles, store.plans, store.allocations, store.logs],
  () => {
    localStorage.setItem(
      "hxwlfront-19-emergency-dispatch-v2",
      JSON.stringify({
        stations: store.stations,
        vehicles: store.vehicles,
        plans: store.plans,
        allocations: store.allocations,
        logs: store.logs
      })
    );
  },
  { deep: true }
);

onMounted(() => {
  // 超过一天未送达的占用回到待分配
  const swept = store.sweepTimedOut();
  if (swept > 0) ElMessage.warning(`已自动回收 ${swept} 笔超 24 小时未送达的占用`);
});
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 应急保供调度台</p>
          <h1>油品应急配送调度台</h1>
          <p class="subtitle">
            油站登记备用库存、所需油品与缺口；调度按优先级从待发车计划中分配。
            已发车 / 已到站不再占用额度，同车同时段只接一趟，超 24 小时未送达自动回收。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Element Plus</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="card in metricCards" :key="card.label" class="metric">
          <span>{{ card.label }}</span>
          <strong>{{ card.value }}</strong>
          <small class="muted">{{ card.sub }}</small>
        </article>
      </section>

      <nav class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>

      <section class="tab-body">
        <DispatchPanel v-show="activeTab === 'dispatch'" />
        <StationPanel v-show="activeTab === 'stations'" />
        <PlanPanel v-show="activeTab === 'plans'" />
        <LogPanel v-show="activeTab === 'logs'" />
      </section>
    </div>
  </main>
</template>
