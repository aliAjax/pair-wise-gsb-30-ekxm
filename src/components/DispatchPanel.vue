<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { PRIORITY_META } from "../types";
import { useDispatchStore } from "../store";
import { ageHours, formatTime } from "../utils";

const store = useDispatchStore();

// 每条待分配需求各自的分配表单
const drafts = reactive<Record<string, { planId: string; tons: number }>>({});
function draftFor(requestId: string, openGap: number) {
  if (!drafts[requestId]) drafts[requestId] = { planId: "", tons: openGap };
  return drafts[requestId];
}

const logRefresh = ref(0);

function allocate(requestId: string, openGap: number) {
  logRefresh.value++;
  const draft = draftFor(requestId, openGap);
  if (!draft.planId) {
    ElMessage.error("请选择配送计划，或在右侧查看退回缺口");
    return;
  }
  const result = store.allocate({
    requestId,
    planId: draft.planId === "none" ? null : draft.planId,
    tons: Number(draft.tons)
  });
  if (result.ok) {
    ElMessage.success(result.error ? `已分配 ${result.allocated} 吨（部分装不下）` : `已分配 ${result.allocated} 吨`);
    draft.planId = "";
    draft.tons = store.openGapOf(store.stationById(requestId)!);
  } else {
    ElMessage.error(result.error ?? "分配失败");
  }
}

// 显式登记"无车可派"的缺口
async function registerShortage(requestId: string, openGap: number) {
  const { value } = await ElMessageBox.prompt("说明退回原因（将写明缺口并留痕）", "退回并登记缺口", {
    confirmButtonText: "确认退回",
    cancelButtonText: "取消",
    inputValue: `无可用配送计划，缺口 ${openGap} 吨`
  }).catch(() => ({ value: null }));
  if (value === null) return;
  const result = store.allocate({ requestId, planId: null, tons: openGap, reason: value });
  if (!result.ok) ElMessage.error(result.error ?? "登记失败");
  else ElMessage.warning("已退回并登记缺口");
}

function autoRun() {
  const result = store.autoAllocate();
  if (result.matched > 0) ElMessage.success(`已自动切出 ${result.matched} 笔、${result.covered} 吨`);
  else if (result.shortTons > 0) ElMessage.warning(`无可分配额度，已登记 ${result.shortTons} 吨缺口`);
  else ElMessage.info("所有需求均已覆盖");
}

async function confirmDelivery(id: string, maxTons: number) {
  const { value } = await ElMessageBox.prompt(`实际送达吨数（最大 ${maxTons} 吨）`, "确认实际送达", {
    confirmButtonText: "确认送达",
    cancelButtonText: "取消",
    inputValue: String(maxTons),
    inputPattern: /^\d+(\.\d+)?$/,
    inputErrorMessage: "请输入有效吨数"
  }).catch(() => ({ value: null }));
  if (value === null) return;
  const result = store.confirmDelivery(id, Number(value));
  if (result.ok) ElMessage.success(`已核减库存、释放 ${result.tons} 吨额度`);
  else ElMessage.error(result.error ?? "操作失败");
}

async function release(id: string) {
  const { value } = await ElMessageBox.prompt("释放原因（占用将回到待分配）", "释放占用", {
    confirmButtonText: "释放",
    cancelButtonText: "取消",
    inputValue: "调度释放"
  }).catch(() => ({ value: null }));
  if (value === null) return;
  const result = store.releaseAllocation(id, value);
  if (result.ok) ElMessage.warning("占用已释放，回到待分配");
}

const openRequests = () =>
  [...store.stations]
    .filter((s) => store.openGapOf(s) > 0)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

const activeAllocations = () =>
  store.allocations
    .filter((a) => a.status === "占用中")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const closedAllocations = () =>
  store.allocations
    .filter((a) => a.status !== "占用中")
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));

const statusClass: Record<string, string> = {
  已送达: "ok",
  已退回: "danger-badge",
  已回收: "warn"
};
</script>

<template>
  <div class="dispatch">
    <div class="toolbar sticky-toolbar">
      <div>
        <h2>待分配需求</h2>
        <span class="muted">按优先级从可用（待发车）计划中切额度</span>
      </div>
      <button type="button" @click="autoRun">⚡ 一键按优先级自动分配</button>
    </div>

    <div class="split">
      <!-- 左：待分配 + 手动切额度 -->
      <div class="record-grid">
        <div v-if="openRequests().length === 0" class="empty">所有缺口均已覆盖或正在途 🎉</div>
        <article v-for="station in openRequests()" :key="station.id" class="record request-card">
          <div class="record-head">
            <div class="record-title-wrap">
              <span class="priority-dot" :style="{ background: PRIORITY_META[station.priority].color }" />
              <p class="record-title">{{ station.name }}</p>
              <span class="badge" :style="{ color: PRIORITY_META[station.priority].color, borderColor: PRIORITY_META[station.priority].color }">
                P{{ station.priority }} {{ PRIORITY_META[station.priority].label }}
              </span>
            </div>
            <strong class="gap-num">{{ store.openGapOf(station) }} 吨待分配</strong>
          </div>
          <p class="muted small">{{ station.fuel }} · {{ station.note || "无备注" }}</p>

          <div class="alloc-form">
            <label>
              可用配送计划
              <select v-model="draftFor(station.id, store.openGapOf(station)).planId">
                <option value="" disabled>请选择待发车计划</option>
                <option v-if="store.candidatePlans(station.id).length === 0" disabled>无油品匹配且有额度的计划</option>
                <option
                  v-for="entry in store.candidatePlans(station.id)"
                  :key="entry.plan.id"
                  :value="entry.plan.id"
                >
                  {{ entry.plan.date }} {{ entry.plan.slot }} · {{ entry.vehicle?.plate }} · 余 {{ entry.remaining }} 吨 /
                  载重 {{ entry.vehicle?.capacityTons }}
                </option>
              </select>
            </label>
            <label class="tons-input">
              分配吨数
              <input
                v-model.number="draftFor(station.id, store.openGapOf(station)).tons"
                type="number"
                min="0.1"
                step="0.1"
              />
            </label>
            <button type="button" @click="allocate(station.id, store.openGapOf(station))">分配</button>
            <button class="secondary" type="button" @click="registerShortage(station.id, store.openGapOf(station))">
              退回并写明缺口
            </button>
          </div>
        </article>
      </div>

      <!-- 右：占用中（在途） -->
      <div class="list-panel">
        <div class="toolbar">
          <h2>占用中 / 在途</h2>
          <span class="muted">超 24 小时未送达自动回收</span>
        </div>
        <div class="record-grid">
          <div v-if="activeAllocations().length === 0" class="empty">暂无占用中的分配</div>
          <article v-for="a in activeAllocations()" :key="a.id" class="record active-card" :class="{ stale: ageHours(a.createdAt) >= 20 }">
            <div class="record-head">
              <p class="record-title">
                {{ store.stationById(a.requestId)?.name }} · {{ a.fuel }} {{ a.tons }} 吨
              </p>
              <span class="status warn">占用 {{ ageHours(a.createdAt).toFixed(1) }}h</span>
            </div>
            <p class="muted small">
              车辆 {{ store.vehicleById(a.vehicleId)?.plate ?? "—" }} ·
              {{ store.planById(a.planId)?.date }} {{ store.planById(a.planId)?.slot }} ·
              {{ formatTime(a.createdAt) }} 切出
            </p>
            <p class="note">{{ a.reason }}</p>
            <div class="actions">
              <button type="button" @click="confirmDelivery(a.id, a.tons)">确认送达 · 核减释放</button>
              <button class="secondary" type="button" @click="release(a.id)">释放回待分配</button>
            </div>
          </article>
        </div>
      </div>
    </div>

    <!-- 已闭环记录：送达 / 退回 / 回收 -->
    <section class="history-panel">
      <div class="toolbar">
        <h2>送达与退回留痕</h2>
        <span class="muted">已发车或已到站的计划不会再出现在可分配池</span>
      </div>
      <div class="table-wrap">
        <table class="history-table">
          <thead>
            <tr>
              <th>油站</th><th>油品/吨数</th><th>车辆</th><th>状态</th><th>说明</th><th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="closedAllocations().length === 0">
              <td colspan="6" class="empty">暂无闭环记录</td>
            </tr>
            <tr v-for="a in closedAllocations()" :key="a.id">
              <td>{{ store.stationById(a.requestId)?.name ?? "—" }}</td>
              <td>{{ a.fuel }} {{ a.tons }}t</td>
              <td>{{ store.vehicleById(a.vehicleId)?.plate ?? "—" }}</td>
              <td><span class="status" :class="statusClass[a.status]">{{ a.status }}</span></td>
              <td class="reason-cell">{{ a.reason }}</td>
              <td class="muted small">{{ a.decidedAt ? formatTime(a.decidedAt) : "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
