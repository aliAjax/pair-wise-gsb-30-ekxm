<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { FUELS, PRIORITY_META, gapOf, round1, slotFromDate } from "./constants";
import { useDispatchStore } from "./store";
import type { Demand, Fuel, Plan, Priority } from "./types";

const store = useDispatchStore();
store.load();
// 进入调度台先回收一次超期占额
const reclaimedOnLoad = store.reclaimStale();

type Tab = "board" | "demand" | "dispatch" | "plans" | "vehicles";
const tab = ref<Tab>("board");

const tabs: { key: Tab; label: string }[] = [
  { key: "board", label: "应急看板" },
  { key: "demand", label: "油站登记" },
  { key: "dispatch", label: "分配调度" },
  { key: "plans", label: "配送计划" },
  { key: "vehicles", label: "车辆运力" }
];

/* ---------------- 指标 ---------------- */

const metrics = computed(() => {
  let totalGap = 0;
  let p1Pending = 0;
  let inbound = 0;
  let deliveredToday = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const d of store.demands) {
    totalGap += store.remainingGap(d.id);
    if (d.priority === 1 && store.remainingGap(d.id) > 0.05) p1Pending++;
    inbound += store.inboundTons(d.id);
  }
  for (const a of store.allocations) {
    if (a.status === "已送达" && a.deliveredAt?.slice(0, 10) === today) {
      deliveredToday += a.deliveredTons ?? a.tons;
    }
  }
  return [
    { label: "待分配缺口", value: `${round1(totalGap)} 吨` },
    { label: "一级紧急未闭环", value: `${p1Pending} 站` },
    { label: "在途保供油量", value: `${round1(inbound)} 吨` },
    { label: "今日实际送达", value: `${round1(deliveredToday)} 吨` }
  ];
});

const sortedDemands = computed(() =>
  [...store.demands].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)
  )
);

function statusClass(d: Demand) {
  return {
    待分配: "st-red",
    部分已配: "st-orange",
    保供中: "st-blue",
    已完成: "st-green"
  }[store.demandStatus(d)];
}

function progress(d: Demand) {
  const gap = gapOf(d);
  const delivered = store.deliveredTons(d.id);
  const inbound = store.inboundTons(d.id);
  const pending = store.pendingTons(d.id);
  const pct = (x: number) => `${Math.min(100, (x / Math.max(gap, 0.01)) * 100)}%`;
  return { gap, delivered, inbound, pending, pct };
}

/* ---------------- 油站登记 ---------------- */

const demandForm = reactive({
  station: "",
  fuel: FUELS[0] as Fuel,
  backup: 0,
  required: 0,
  priority: 1 as Priority,
  incident: "",
  contact: ""
});

function submitDemand() {
  if (!demandForm.station.trim()) return;
  store.addDemand({
    station: demandForm.station.trim(),
    fuel: demandForm.fuel,
    backup: round1(Number(demandForm.backup) || 0),
    required: round1(Number(demandForm.required) || 0),
    priority: demandForm.priority,
    incident: demandForm.incident.trim() || "应急保供",
    contact: demandForm.contact.trim() || "—"
  });
  demandForm.station = "";
  demandForm.backup = 0;
  demandForm.required = 0;
  demandForm.incident = "";
  demandForm.contact = "";
}

/* ---------------- 分配调度 ---------------- */

const selectedDemandId = ref("");
const selectedPlanId = ref("");
const allocateTons = ref(0);
const allocateMsg = ref<{ ok: boolean; text: string } | null>(null);
const autoLog = ref<string[]>([]);

const dispatchablePlans = computed(() =>
  store.plans
    .filter((p) => p.status === "待发车" && store.availableTons(p.id) > 0.05)
    .sort((a, b) => a.slot.localeCompare(b.slot))
);

function goAllocate(d: Demand) {
  selectedDemandId.value = d.id;
  // 默认选一辆油品匹配且有额度的计划
  const match = dispatchablePlans.value.find((p) => p.fuel === d.fuel);
  selectedPlanId.value = match?.id ?? "";
  allocateTons.value = Math.min(
    store.remainingGap(d.id),
    match ? store.availableTons(match.id) : 0
  );
  allocateMsg.value = null;
  tab.value = "dispatch";
}

function runAuto() {
  const r = store.autoAllocate();
  autoLog.value = r.allocated === 0 && r.lines.length === 0
    ? ["所有需求缺口均已覆盖，暂无待分配任务"]
    : r.lines;
}

function doAllocate() {
  if (!selectedDemandId.value || !selectedPlanId.value) {
    allocateMsg.value = { ok: false, text: "请先选择需求和配送计划" };
    return;
  }
  const r = store.allocate(
    selectedDemandId.value,
    selectedPlanId.value,
    Number(allocateTons.value)
  );
  allocateMsg.value = { ok: r.ok, text: r.message };
  if (r.ok) allocateTons.value = 0;
}

function reject(aId: string) {
  const reason = window.prompt("请写明退回原因与剩余缺口：", "车辆载重不足，缺口待补运力");
  if (reason !== null) store.rejectAllocation(aId, reason);
}

const pendingAllocations = computed(() =>
  store.allocations
    .filter((a) => a.status === "待发车" || a.status === "运输中")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

// 切换需求/计划时自动带出建议分配量（剩余缺口与可用额度取小）
watch([selectedDemandId, selectedPlanId], () => {
  const gap = selectedDemandId.value ? store.remainingGap(selectedDemandId.value) : 0;
  const avail = selectedPlanId.value ? store.availableTons(selectedPlanId.value) : 0;
  allocateTons.value = round1(Math.min(gap, avail));
});

/* ---------------- 配送计划 ---------------- */

const planForm = reactive({
  vehicleId: "",
  date: new Date().toISOString().slice(0, 10),
  half: "am" as "am" | "pm",
  customSlot: "",
  fuel: FUELS[0] as Fuel,
  tons: 0,
  station: "",
  planArriveAt: new Date().toISOString().slice(0, 10),
  notes: ""
});

const planVehicle = computed(() => store.vehicles.find((v) => v.id === planForm.vehicleId));
const planSlot = computed(() =>
  planForm.customSlot.trim() || slotFromDate(planForm.date, planForm.half)
);
const slotConflict = computed(() =>
  planForm.vehicleId
    ? store.vehicleSlotTaken(planForm.vehicleId, planSlot.value)
    : undefined
);
const overCapacity = computed(
  () => planVehicle.value !== undefined && Number(planForm.tons) > planVehicle.value.capacity
);
const fuelMismatch = computed(
  () => planVehicle.value !== undefined && !planVehicle.value.fuels.includes(planForm.fuel)
);

function submitPlan() {
  if (!planForm.vehicleId || !planForm.station.trim()) return;
  if (slotConflict.value) {
    window.alert(`同一车辆在 ${planSlot.value} 已有一趟任务，不能再接`);
    return;
  }
  if (fuelMismatch.value) {
    window.alert("车辆不具备该油品运输资质，请更换车辆或油品");
    return;
  }
  if (overCapacity.value) {
    window.alert(`配载超过车辆核定载重 ${planVehicle.value?.capacity} 吨`);
    return;
  }
  store.addPlan({
    vehicleId: planForm.vehicleId,
    slot: planSlot.value,
    fuel: planForm.fuel,
    tons: round1(Number(planForm.tons) || 0),
    station: planForm.station.trim(),
    planArriveAt: planForm.planArriveAt,
    notes: planForm.notes.trim() || "待发车"
  });
  planForm.station = "";
  planForm.tons = 0;
  planForm.notes = "";
}

function depart(p: Plan) {
  store.departPlan(p.id);
}

function arrive(p: Plan) {
  const input = window.prompt(
    `确认 ${p.code} 实际送达吨数（可短卸，计划 ${p.tons} 吨）：`,
    String(p.tons)
  );
  if (input === null) return;
  const val = Number(input);
  if (!(val >= 0)) return;
  store.arrivePlan(p.id, val);
}

/* ---------------- 车辆 ---------------- */

const vehicleForm = reactive({
  name: "",
  capacity: 0,
  fuels: [FUELS[0]] as Fuel[],
  slotsText: ""
});

function toggleFuel(f: Fuel) {
  const i = vehicleForm.fuels.indexOf(f);
  if (i >= 0) vehicleForm.fuels.splice(i, 1);
  else vehicleForm.fuels.push(f);
}

function submitVehicle() {
  if (!vehicleForm.name.trim() || vehicleForm.fuels.length === 0) return;
  const slots = vehicleForm.slotsText
    .split(/[，,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  store.addVehicle({
    name: vehicleForm.name.trim(),
    capacity: round1(Number(vehicleForm.capacity) || 0),
    fuels: [...vehicleForm.fuels],
    slots:
      slots.length > 0
        ? slots
        : [
            slotFromDate(new Date().toISOString().slice(0, 10), "am"),
            slotFromDate(new Date().toISOString().slice(0, 10), "pm")
          ]
  });
  vehicleForm.name = "";
  vehicleForm.capacity = 0;
  vehicleForm.fuels = [FUELS[0]];
  vehicleForm.slotsText = "";
}

/* ---------------- 公共展示 ---------------- */

function vehicleName(id: string) {
  return store.vehicleMap[id]?.name ?? "未指派车辆";
}

function demandName(id: string) {
  const d = store.demands.find((x) => x.id === id);
  return d ? `${d.station}·${d.fuel}` : "—";
}

function planCode(id: string) {
  return store.plans.find((p) => p.id === id)?.code ?? "—";
}

function reclaimNow() {
  const n = store.reclaimStale();
  window.alert(n > 0 ? `已回收 ${n} 笔超期占额，油量回到待分配` : "暂无超过一天未送达的占用");
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 应急保供调度台</p>
          <h1>油品应急配送调度</h1>
          <p class="subtitle">
            停电、封路等突发情况下：油站登记备用库存与缺口，调度按优先级从可用配送计划分配运力；
            已发车/已到站油量不再占用额度，一车一时段一趟，实际送达核减库存，超 24 小时未送达自动回收。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">localStorage</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          :class="['tab', { active: tab === t.key }]"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
        <button type="button" class="tab tab-warn" @click="reclaimNow">回收超期占用</button>
        <button type="button" class="tab tab-danger" @click="store.resetDemo()">重置演示数据</button>
      </nav>

      <!-- ================= 应急看板 ================= -->
      <section v-if="tab === 'board'" class="panel">
        <div class="toolbar">
          <h2>油站保供需求（按优先级）</h2>
          <button type="button" @click="runAuto(); tab = 'dispatch'">一键按优先级分配</button>
        </div>
        <p v-if="reclaimedOnLoad > 0" class="banner warn">
          进入时自动回收 {{ reclaimedOnLoad }} 笔超过一天未送达的占用，相关油量已回到待分配。
        </p>

        <div v-if="sortedDemands.length === 0" class="empty">暂无油站登记，请先到「油站登记」上报备用库存与缺口</div>
        <div class="demand-grid">
          <article v-for="d in sortedDemands" :key="d.id" class="demand-card">
            <div class="record-head">
              <div>
                <p class="record-title">{{ d.station }}</p>
                <p class="sub">{{ d.fuel }} · {{ d.contact }}</p>
              </div>
              <div class="head-right">
                <span class="prio" :style="{ color: PRIORITY_META[d.priority].color, background: PRIORITY_META[d.priority].bg }">
                  {{ PRIORITY_META[d.priority].label }}
                </span>
                <span class="status" :class="statusClass(d)">{{ store.demandStatus(d) }}</span>
              </div>
            </div>

            <p class="incident">⚠ {{ d.incident }}</p>

            <div class="stock-line">
              <span>备用库存 <b>{{ d.backup }}</b> 吨</span>
              <span>保供所需 <b>{{ d.required }}</b> 吨</span>
              <span>总缺口 <b class="hot">{{ gapOf(d) }}</b> 吨</span>
            </div>

            <div class="stack-bar" :title="`已送达 ${progress(d).delivered} / 在途 ${progress(d).inbound} / 待发 ${progress(d).pending}`">
              <div class="seg seg-delivered" :style="{ width: progress(d).pct(progress(d).delivered) }" />
              <div class="seg seg-inbound" :style="{ width: progress(d).pct(progress(d).inbound) }" />
              <div class="seg seg-pending" :style="{ width: progress(d).pct(progress(d).pending) }" />
            </div>
            <div class="legend">
              <span><i class="dot seg-delivered" />已核减 {{ progress(d).delivered }} 吨</span>
              <span><i class="dot seg-inbound" />在途 {{ progress(d).inbound }} 吨</span>
              <span><i class="dot seg-pending" />待发占额 {{ progress(d).pending }} 吨</span>
              <span>剩余缺口 {{ store.remainingGap(d.id) }} 吨</span>
            </div>

            <div class="actions">
              <button type="button" :disabled="store.remainingGap(d.id) <= 0.05" @click="goAllocate(d)">
                分配运力
              </button>
              <button type="button" class="secondary" @click="tab = 'dispatch'">查看占额</button>
              <button type="button" class="danger" @click="store.removeDemand(d.id)">撤销登记</button>
            </div>
          </article>
        </div>
      </section>

      <!-- ================= 油站登记 ================= -->
      <section v-if="tab === 'demand'" class="workspace">
        <form class="panel" @submit.prevent="submitDemand">
          <h2>油站应急登记</h2>
          <div class="form-grid">
            <label>油站名称
              <input v-model="demandForm.station" placeholder="如：城东站" required />
            </label>
            <label>所需油品
              <select v-model="demandForm.fuel">
                <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label>备用库存（吨）
              <input v-model.number="demandForm.backup" type="number" min="0" step="0.1" required />
            </label>
            <label>保供所需（吨）
              <input v-model.number="demandForm.required" type="number" min="0" step="0.1" required />
            </label>
            <label>保供优先级
              <select v-model.number="demandForm.priority">
                <option :value="1">一级 · 紧急（断供风险）</option>
                <option :value="2">二级 · 重要</option>
                <option :value="3">三级 · 常规备货</option>
              </select>
            </label>
            <label>值班联系人
              <input v-model="demandForm.contact" placeholder="姓名 / 电话" />
            </label>
            <label class="full">突发情况（停电 / 封路等）
              <textarea v-model="demandForm.incident" placeholder="说明事件、预计持续时间、通行限制等" />
            </label>
            <button type="submit">登记备用库存与缺口</button>
            <p v-if="demandForm.required - demandForm.backup > 0" class="banner info">
              登记后将产生 {{ round1(demandForm.required - demandForm.backup) }} 吨待保供缺口
            </p>
          </div>
        </form>

        <section class="list-panel">
          <h2>已登记油站（{{ store.demands.length }}）</h2>
          <div class="record-grid">
            <div v-if="store.demands.length === 0" class="empty">暂无登记</div>
            <article v-for="d in sortedDemands" :key="d.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ d.station }} · {{ d.fuel }}</p>
                <span class="prio" :style="{ color: PRIORITY_META[d.priority].color, background: PRIORITY_META[d.priority].bg }">
                  {{ PRIORITY_META[d.priority].label }}
                </span>
              </div>
              <div class="details">
                <span>备用库存: {{ d.backup }} 吨</span>
                <span>所需: {{ d.required }} 吨</span>
                <span>缺口: {{ gapOf(d) }} 吨</span>
                <span>状态: {{ store.demandStatus(d) }}</span>
              </div>
              <p class="note">{{ d.incident }}</p>
            </article>
          </div>
        </section>
      </section>

      <!-- ================= 分配调度 ================= -->
      <section v-if="tab === 'dispatch'" class="workspace">
        <div class="panel">
          <h2>分配运力</h2>
          <div class="form-grid">
            <button type="button" @click="runAuto">按优先级自动分配（一级优先 · 先登记先配）</button>

            <label>保供需求
              <select v-model="selectedDemandId">
                <option value="" disabled>请选择油站需求</option>
                <option v-for="d in sortedDemands" :key="d.id" :value="d.id">
                  {{ PRIORITY_META[d.priority].label }}｜{{ d.station }}·{{ d.fuel }}
                  （缺口 {{ gapOf(d) }}，剩余 {{ store.remainingGap(d.id) }} 吨）
                </option>
              </select>
            </label>
            <label>可用配送计划（仅待发车且有额度）
              <select v-model="selectedPlanId">
                <option value="" disabled>请选择配送计划</option>
                <option v-for="p in dispatchablePlans" :key="p.id" :value="p.id">
                  {{ p.code }}｜{{ vehicleName(p.vehicleId) }}｜{{ p.slot }}｜{{ p.fuel }}
                  ｜可配 {{ store.availableTons(p.id) }}/{{ p.tons }} 吨
                </option>
              </select>
            </label>
            <label>本次分配（吨）
              <input v-model.number="allocateTons" type="number" min="0" step="0.1" />
            </label>
            <button type="button" @click="doAllocate">确认分配</button>
            <p v-if="allocateMsg" class="banner" :class="allocateMsg.ok ? 'ok' : 'warn'">
              {{ allocateMsg.ok ? "✓ " : "✗ " }}{{ allocateMsg.text }}
            </p>
            <p v-if="selectedPlanId && selectedDemandId" class="banner info">
              校验规则：油品必须一致；载重不足仅按可用额度承运并登记缺口；
              同一车辆同一时段只接一趟；发车后占额即锁定不可退。
            </p>
          </div>

          <ul v-if="autoLog.length" class="log">
            <li v-for="(line, i) in autoLog" :key="i">{{ line }}</li>
          </ul>
        </div>

        <section class="list-panel">
          <h2>占额明细（{{ pendingAllocations.length }} 笔在途/待发）</h2>
          <div class="record-grid">
            <div v-if="pendingAllocations.length === 0" class="empty">暂无有效占额</div>
            <article v-for="a in pendingAllocations" :key="a.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ demandName(a.demandId) }} ← {{ planCode(a.planId) }}</p>
                <span class="status" :class="a.status === '待发车' ? 'st-orange' : 'st-blue'">{{ a.status }}</span>
              </div>
              <div class="details">
                <span>占额: {{ a.tons }} 吨</span>
                <span>车辆: {{ vehicleName(store.plans.find((p) => p.id === a.planId)?.vehicleId ?? '') }}</span>
              </div>
              <p v-if="a.reason" class="note">{{ a.reason }}</p>
              <div class="actions">
                <button
                  type="button"
                  class="danger"
                  :disabled="a.status !== '待发车'"
                  :title="a.status !== '待发车' ? '已发车的油量不可退回' : ''"
                  @click="reject(a.id)"
                >
                  退回并写明缺口
                </button>
              </div>
            </article>
          </div>

          <div class="record-grid" style="margin-top: 14px">
            <article v-for="a in store.allocations.filter((x) => ['已退回', '已回收', '已送达'].includes(x.status)).slice(-6).reverse()" :key="a.id" class="record record-dim">
              <div class="record-head">
                <p class="record-title">{{ demandName(a.demandId) }} · {{ planCode(a.planId) }}</p>
                <span class="status" :class="{ 'st-red': a.status !== '已送达', 'st-green': a.status === '已送达' }">{{ a.status }}</span>
              </div>
              <p class="note">{{ a.tons }} 吨｜{{ a.reason || (a.status === '已送达' ? `实际核减 ${a.deliveredTons ?? a.tons} 吨` : '') }}</p>
            </article>
          </div>
        </section>
      </section>

      <!-- ================= 配送计划 ================= -->
      <section v-if="tab === 'plans'" class="workspace">
        <form class="panel" @submit.prevent="submitPlan">
          <h2>新增配送计划</h2>
          <div class="form-grid">
            <label>承运车辆
              <select v-model="planForm.vehicleId" required>
                <option value="" disabled>请选择车辆</option>
                <option v-for="v in store.vehicles" :key="v.id" :value="v.id">
                  {{ v.name }}（载重 {{ v.capacity }} 吨）
                </option>
              </select>
            </label>
            <label>执行时段
              <input v-model="planForm.date" type="date" />
            </label>
            <label>上午 / 下午
              <select v-model="planForm.half">
                <option value="am">上午</option>
                <option value="pm">下午</option>
              </select>
            </label>
            <label>或自定义时段
              <input v-model="planForm.customSlot" placeholder="如：2026-09-25 夜间（留空用上方选择）" />
            </label>
            <label>油品
              <select v-model="planForm.fuel">
                <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label>发油量（吨）
              <input v-model.number="planForm.tons" type="number" min="0" step="0.1" required />
            </label>
            <label>目标油站
              <input v-model="planForm.station" required />
            </label>
            <label>计划到达日期
              <input v-model="planForm.planArriveAt" type="date" />
            </label>
            <label class="full">备注
              <textarea v-model="planForm.notes" />
            </label>
            <p v-if="slotConflict" class="banner warn">✗ 该车在 {{ planSlot }} 已有一趟（{{ slotConflict.code }}），不能再接</p>
            <p v-else-if="fuelMismatch" class="banner warn">✗ 车辆无 {{ planForm.fuel }} 运输资质</p>
            <p v-else-if="overCapacity" class="banner warn">✗ 超过核定载重 {{ planVehicle?.capacity }} 吨</p>
            <button type="submit" :disabled="!!slotConflict || fuelMismatch || overCapacity">保存配送计划</button>
          </div>
        </form>

        <section class="list-panel">
          <h2>配送计划列表（{{ store.plans.length }}）</h2>
          <div class="record-grid">
            <div v-if="store.plans.length === 0" class="empty">暂无配送计划</div>
            <article v-for="p in [...store.plans].reverse()" :key="p.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ p.code }} · {{ p.station }}</p>
                <span class="status" :class="{ 'st-orange': p.status === '待发车', 'st-blue': p.status === '运输中', 'st-green': p.status === '已到站' }">
                  {{ p.status }}
                </span>
              </div>
              <div class="details">
                <span>车辆: {{ vehicleName(p.vehicleId) }}</span>
                <span>时段: {{ p.slot }}</span>
                <span>油品: {{ p.fuel }}</span>
                <span>发油量: {{ p.tons }} 吨</span>
                <span v-if="p.status === '待发车'">可分配额度: <b class="hot">{{ store.availableTons(p.id) }}</b> 吨</span>
                <span>计划到达: {{ p.planArriveAt }}</span>
              </div>
              <p class="note">{{ p.notes }}</p>
              <div class="actions">
                <button type="button" :disabled="p.status !== '待发车'" @click="depart(p)">确认发车</button>
                <button type="button" class="secondary" :disabled="p.status !== '运输中'" @click="arrive(p)">
                  实际送达并核减
                </button>
                <button
                  type="button"
                  class="danger"
                  :disabled="store.allocations.some((a) => a.planId === p.id && ['待发车', '运输中'].includes(a.status))"
                  @click="store.removePlan(p.id)"
                >
                  删除
                </button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <!-- ================= 车辆运力 ================= -->
      <section v-if="tab === 'vehicles'" class="workspace">
        <form class="panel" @submit.prevent="submitVehicle">
          <h2>登记车辆</h2>
          <div class="form-grid">
            <label>车牌 / 名称
              <input v-model="vehicleForm.name" required />
            </label>
            <label>核定载重（吨）
              <input v-model.number="vehicleForm.capacity" type="number" min="0" step="0.1" required />
            </label>
            <label class="full">可承运油品
              <div class="checks">
                <label v-for="f in FUELS" :key="f" class="check">
                  <input type="checkbox" :checked="vehicleForm.fuels.includes(f)" @change="toggleFuel(f)" />
                  {{ f }}
                </label>
              </div>
            </label>
            <label class="full">可执行时段（逗号或换行分隔）
              <textarea v-model="vehicleForm.slotsText" placeholder="2026-09-25 上午, 2026-09-25 下午" />
            </label>
            <button type="submit">保存车辆</button>
          </div>
        </form>

        <section class="list-panel">
          <h2>车辆台账（{{ store.vehicles.length }}）</h2>
          <div class="record-grid">
            <article v-for="v in store.vehicles" :key="v.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ v.name }}</p>
                <span class="status st-blue">载重 {{ v.capacity }} 吨</span>
              </div>
              <div class="details">
                <span v-for="f in v.fuels" :key="f">油品: {{ f }}</span>
              </div>
              <p class="note">时段：{{ v.slots.join("、") }}</p>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
