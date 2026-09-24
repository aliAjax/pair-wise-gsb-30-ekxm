<script setup lang="ts">
import { reactive } from "vue";
import { ElMessage } from "element-plus";
import { FUELS, PLAN_STATUSES, SLOTS, type Fuel, type Slot } from "../types";
import { useDispatchStore } from "../store";

const store = useDispatchStore();

function today() {
  return new Date().toISOString().slice(0, 10);
}

const planForm = reactive<{
  vehicleId: string;
  fuel: Fuel | "";
  totalTons: number;
  date: string;
  slot: Slot;
}>({
  vehicleId: "",
  fuel: "",
  totalTons: 10,
  date: today(),
  slot: "上午"
});

const vehicleForm = reactive({
  plate: "",
  capacityTons: 20,
  fuels: [] as Fuel[]
});

function submitPlan() {
  const result = store.addPlan({
    vehicleId: planForm.vehicleId,
    fuel: planForm.fuel as Fuel,
    totalTons: Number(planForm.totalTons),
    date: planForm.date,
    slot: planForm.slot
  });
  if (!result.ok) {
    ElMessage.error(result.error);
    return;
  }
  ElMessage.success("配送计划已创建，进入待发车池");
  planForm.vehicleId = "";
  planForm.fuel = "";
  planForm.totalTons = 10;
}

function submitVehicle() {
  const result = store.addVehicle({
    plate: vehicleForm.plate,
    capacityTons: Number(vehicleForm.capacityTons),
    fuels: vehicleForm.fuels
  });
  if (!result.ok) {
    ElMessage.error(result.error);
    return;
  }
  ElMessage.success("车辆已入库");
  vehicleForm.plate = "";
  vehicleForm.capacityTons = 20;
  vehicleForm.fuels = [];
}

function toggleFuel(fuel: Fuel) {
  const idx = vehicleForm.fuels.indexOf(fuel);
  if (idx >= 0) vehicleForm.fuels.splice(idx, 1);
  else vehicleForm.fuels.push(fuel);
}

const flowLabel: Record<string, string> = {
  待发车: "发车（退出可分配）",
  运输中: "登记到站",
  已到站: "已到站"
};

const sortedPlans = () =>
  [...store.plans].sort((a, b) => b.date.localeCompare(a.date) || a.slot.localeCompare(b.slot));
</script>

<template>
  <div class="split plans-split">
    <div class="side-col">
      <form class="panel form-panel" @submit.prevent="submitVehicle">
        <h2>车辆入库</h2>
        <div class="form-grid">
          <label>
            车牌
            <input v-model="vehicleForm.plate" placeholder="京A·0000" required />
          </label>
          <label>
            载重（吨）
            <input v-model.number="vehicleForm.capacityTons" type="number" min="0.1" step="0.1" required />
          </label>
          <label>
            可运油品（不符将被退回）
            <div class="check-row">
              <label v-for="fuel in FUELS" :key="fuel" class="check-item">
                <input type="checkbox" :checked="vehicleForm.fuels.includes(fuel)" @change="toggleFuel(fuel)" />
                <span>{{ fuel }}</span>
              </label>
            </div>
          </label>
          <button type="submit">入库</button>
        </div>
      </form>

      <form class="panel form-panel" @submit.prevent="submitPlan">
        <h2>创建配送计划</h2>
        <p class="panel-hint">同车同时段只排一趟；载重不足或油品不符直接退回。</p>
        <div class="form-grid">
          <label>
            车辆
            <select v-model="planForm.vehicleId" required>
              <option value="">请选择车辆</option>
              <option v-for="v in store.vehicles" :key="v.id" :value="v.id">
                {{ v.plate }} · {{ v.capacityTons }}吨 · {{ v.fuels.join("/") }}
              </option>
            </select>
          </label>
          <label>
            油品
            <select v-model="planForm.fuel" required>
              <option value="">请选择油品</option>
              <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
            </select>
          </label>
          <label>
            配送吨数
            <input v-model.number="planForm.totalTons" type="number" min="0.1" step="0.1" required />
          </label>
          <label>
            计划日期
            <input v-model="planForm.date" type="date" required />
          </label>
          <label>
            时段
            <select v-model="planForm.slot">
              <option v-for="s in SLOTS" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <button type="submit">保存计划（待发车）</button>
        </div>
      </form>
    </div>

    <section class="list-panel">
      <div class="toolbar">
        <h2>配送计划与车辆占用</h2>
        <span class="muted">仅「待发车」可被分配</span>
      </div>
      <div class="record-grid">
        <article v-for="plan in sortedPlans()" :key="plan.id" class="record" :class="{ 'plan-locked': plan.status !== '待发车' }">
          <div class="record-head">
            <p class="record-title">
              {{ store.vehicleById(plan.vehicleId)?.plate }} · {{ plan.fuel }} {{ plan.totalTons }} 吨
            </p>
            <span class="status" :class="{ info: plan.status === '运输中', ok: plan.status === '已到站' }">{{ plan.status }}</span>
          </div>
          <div class="details">
            <span>计划：{{ plan.date }} {{ plan.slot }}</span>
            <span>车辆载重：{{ store.vehicleById(plan.vehicleId)?.capacityTons }} 吨</span>
            <span v-if="plan.status === '待发车'">占用中：{{ store.occupiedOf(plan.id) }} 吨</span>
            <span v-else>在途/到站油量不再占用额度</span>
            <span v-if="plan.status === '待发车'">
              <strong>可分配余额：{{ Math.max(0, plan.totalTons - store.occupiedOf(plan.id)) }} 吨</strong>
            </span>
          </div>
          <div class="actions">
            <button type="button" :disabled="plan.status === '已到站'" @click="store.flowPlan(plan.id)">
              {{ flowLabel[plan.status] }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
