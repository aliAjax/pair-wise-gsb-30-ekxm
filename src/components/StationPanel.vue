<script setup lang="ts">
import { reactive } from "vue";
import { ElMessage } from "element-plus";
import { FUELS, PRIORITIES, PRIORITY_META, STATIONS, type Fuel, type Priority, type StationName } from "../types";
import { useDispatchStore } from "../store";

const store = useDispatchStore();

const form = reactive<{
  name: StationName | "";
  fuel: Fuel | "";
  backupTons: number;
  neededTons: number;
  priority: Priority;
  note: string;
}>({
  name: "",
  fuel: "",
  backupTons: 0,
  neededTons: 10,
  priority: 2,
  note: ""
});

function submit() {
  const result = store.addStation({
    name: form.name as StationName,
    fuel: form.fuel as Fuel,
    backupTons: Number(form.backupTons),
    neededTons: Number(form.neededTons),
    priority: form.priority,
    note: form.note.trim()
  });
  if (!result.ok) {
    ElMessage.error(result.error ?? "登记失败");
    return;
  }
  ElMessage.success("油站需求已登记");
  form.name = "";
  form.fuel = "";
  form.backupTons = 0;
  form.neededTons = 10;
  form.priority = 2;
  form.note = "";
}

function statusOf(id: string) {
  const station = store.stationById(id);
  if (!station) return { label: "—", cls: "" };
  const open = store.openGapOf(station);
  if (store.gapOf(station) <= 0) return { label: "已补齐", cls: "ok" };
  if (open <= 0) return { label: "分配中", cls: "info" };
  return { label: "待分配", cls: "warn" };
}

function remove(id: string) {
  const result = store.removeStation(id);
  if (!result.ok) ElMessage.error(result.error ?? "无法删除");
  else ElMessage.warning("需求登记已删除");
}

const sorted = () =>
  [...store.stations].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
</script>

<template>
  <div class="split">
    <form class="panel form-panel" @submit.prevent="submit">
      <h2>油站需求登记</h2>
      <p class="panel-hint">登记备用库存、所需油品与缺口，调度按优先级分配。</p>
      <div class="form-grid">
        <label>
          油站
          <select v-model="form.name" required>
            <option value="">请选择油站</option>
            <option v-for="name in STATIONS" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label>
          所需油品
          <select v-model="form.fuel" required>
            <option value="">请选择油品</option>
            <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
          </select>
        </label>
        <label>
          备用库存（吨）
          <input v-model.number="form.backupTons" type="number" min="0" step="0.1" required />
        </label>
        <label>
          所需总量（吨）
          <input v-model.number="form.neededTons" type="number" min="0" step="0.1" required />
        </label>
        <label>
          优先级
          <select v-model.number="form.priority">
            <option v-for="p in PRIORITIES" :key="p" :value="p">P{{ p }} · {{ PRIORITY_META[p].label }}</option>
          </select>
        </label>
        <label class="span-2">
          现场情况（停电 / 道路封闭等）
          <textarea v-model="form.note" placeholder="例如：临时停电，主力罐泵停转" />
        </label>
        <button type="submit" class="span-2">登记需求</button>
      </div>
    </form>

    <section class="list-panel">
      <div class="toolbar">
        <h2>缺口看板</h2>
        <span class="muted">按优先级排序，送达后自动核减</span>
      </div>
      <div class="record-grid">
        <div v-if="store.stations.length === 0" class="empty">暂无油站登记</div>
        <article v-for="station in sorted()" :key="station.id" class="record">
          <div class="record-head">
            <div class="record-title-wrap">
              <span class="priority-dot" :style="{ background: PRIORITY_META[station.priority].color }" />
              <p class="record-title">{{ station.name }}</p>
              <span class="badge" :style="{ color: PRIORITY_META[station.priority].color, borderColor: PRIORITY_META[station.priority].color }">
                P{{ station.priority }} {{ PRIORITY_META[station.priority].label }}
              </span>
            </div>
            <span class="status" :class="statusOf(station.id).cls">{{ statusOf(station.id).label }}</span>
          </div>

          <div class="gap-bar">
            <div>
              <span class="muted">{{ station.fuel }}</span>
              <strong>缺口 {{ store.gapOf(station) }} 吨</strong>
            </div>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{
                  width: `${Math.min(100, (store.activeTonsOf(station.id) / Math.max(store.gapOf(station), 0.01)) * 100)}%`
                }"
              />
            </div>
            <span class="muted small">
              备用 {{ station.backupTons }} / 需 {{ station.neededTons }} · 占用中 {{ store.activeTonsOf(station.id) }} · 待分配
              {{ store.openGapOf(station) }}
            </span>
          </div>

          <p class="note">{{ station.note || "暂无现场备注" }}</p>
          <div class="actions">
            <button class="danger" type="button" @click="remove(station.id)">删除登记</button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
