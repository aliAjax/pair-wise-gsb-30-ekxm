import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  ACTIVE_ALLOCATION,
  ALLOCATION_STATUSES,
  type Allocation,
  type DeliveryPlan,
  type DispatchState,
  type Fuel,
  type LogEntry,
  type PlanStatus,
  type Priority,
  type Slot,
  type Station,
  type Vehicle,
  isActive
} from "./types";

const STORAGE_KEY = "hxwlfront-19-emergency-dispatch-v2";
const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 超过一天未送达，占用回到待分配

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function isoHoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function seedState(): DispatchState {
  const vehicles: Vehicle[] = [
    { id: "veh-1", plate: "京A·7210", capacityTons: 30, fuels: ["92号汽油", "95号汽油"] },
    { id: "veh-2", plate: "京A·8835", capacityTons: 20, fuels: ["柴油"] },
    { id: "veh-3", plate: "京B·5506", capacityTons: 25, fuels: ["92号汽油", "95号汽油", "柴油"] },
    { id: "veh-4", plate: "京B·9012", capacityTons: 15, fuels: ["92号汽油"] }
  ];

  const plans: DeliveryPlan[] = [
    // 已发车、已到站：额度不再进入可分配池
    { id: "plan-1", vehicleId: "veh-1", fuel: "92号汽油", totalTons: 18, date: today(0), slot: "上午", status: "运输中", createdAt: isoHoursAgo(10) },
    { id: "plan-2", vehicleId: "veh-2", fuel: "柴油", totalTons: 12, date: today(0), slot: "上午", status: "待发车", createdAt: isoHoursAgo(6) },
    { id: "plan-3", vehicleId: "veh-3", fuel: "95号汽油", totalTons: 24, date: today(0), slot: "下午", status: "待发车", createdAt: isoHoursAgo(3) },
    { id: "plan-4", vehicleId: "veh-4", fuel: "92号汽油", totalTons: 15, date: today(1), slot: "上午", status: "待发车", createdAt: isoHoursAgo(1) },
    // 已到站示例：可直接模拟送达核减
    { id: "plan-5", vehicleId: "veh-2", fuel: "柴油", totalTons: 8, date: today(-1), slot: "下午", status: "已到站", createdAt: isoHoursAgo(26) }
  ];

  const stations: Station[] = [
    { id: "st-1", name: "城东站", fuel: "92号汽油", backupTons: 6, neededTons: 20, priority: 1, note: "临时停电，主力罐泵停转", createdAt: isoHoursAgo(5) },
    { id: "st-2", name: "机场站", fuel: "柴油", backupTons: 4, neededTons: 15, priority: 1, note: "保障机场大巴，道路绕行中", createdAt: isoHoursAgo(4) },
    { id: "st-3", name: "新区站", fuel: "95号汽油", backupTons: 10, neededTons: 28, priority: 2, note: "夜间车流高峰前补库", createdAt: isoHoursAgo(2) },
    { id: "st-4", name: "高新园站", fuel: "92号汽油", backupTons: 2, neededTons: 24, priority: 3, note: "库存偏低", createdAt: isoHoursAgo(1) }
  ];

  const allocations: Allocation[] = [
    // 超时占用示例：创建已超过一天，启动时自动回收到待分配
    {
      id: "al-timeout",
      requestId: "st-4",
      planId: "plan-4",
      vehicleId: "veh-4",
      fuel: "92号汽油",
      tons: 5,
      status: ACTIVE_ALLOCATION,
      reason: "道路封闭预计绕行，未确认送达",
      createdAt: isoHoursAgo(26),
      decidedAt: null
    }
  ];

  const logs: LogEntry[] = [
    { id: uid("log"), level: "info", message: "应急保供调度台已载入示例数据", createdAt: new Date().toISOString() }
  ];

  return { stations, vehicles, plans, allocations, logs };
}

function loadState(): DispatchState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as DispatchState;
    } catch {
      // 数据损坏时回退到示例数据
    }
  }
  return seedState();
}

export interface AllocationInput {
  requestId: string;
  planId: string | null; // 允许"无可用计划、直接登记缺口"
  tons: number;
  reason?: string;
}

export interface ManualPlanInput {
  vehicleId: string;
  fuel: Fuel;
  totalTons: number;
  date: string;
  slot: Slot;
}

export const useDispatchStore = defineStore("dispatch", () => {
  const initial = loadState();
  const stations = ref<Station[]>(initial.stations);
  const vehicles = ref<Vehicle[]>(initial.vehicles);
  const plans = ref<DeliveryPlan[]>(initial.plans);
  const allocations = ref<Allocation[]>(initial.allocations);
  const logs = ref<LogEntry[]>(initial.logs);

  // ---------- 查询 ----------

  const vehicleById = (id: string | null) => vehicles.value.find((v) => v.id === id) ?? null;
  const planById = (id: string | null) => plans.value.find((p) => p.id === id) ?? null;
  const stationById = (id: string) => stations.value.find((s) => s.id === id);

  // 需求缺口 = 所需 - 备用库存（不为负）；送达确认后备用库存增加，缺口随之核减
  const gapOf = (station: Station) => Math.max(0, round1(station.neededTons - station.backupTons));

  // 该需求已切出但尚未闭环的占用量
  const activeTonsOf = (requestId: string) =>
    round1(allocations.value.filter((a) => a.requestId === requestId && isActive(a)).reduce((sum, a) => sum + a.tons, 0));

  // 仍待调度分配的缺口
  const openGapOf = (station: Station) => Math.max(0, round1(gapOf(station) - activeTonsOf(station.id)));

  function occupiedOf(planId: string) {
    return round1(allocations.value.filter((a) => a.planId === planId && isActive(a)).reduce((sum, a) => sum + a.tons, 0));
  }

  // 可分配额度：仅待发车计划，且总量减去占用中分配
  const availablePlans = computed(() =>
    plans.value
      .filter((p) => p.status === "待发车")
      .map((p) => {
        const occupied = occupiedOf(p.id);
        return { plan: p, vehicle: vehicleById(p.vehicleId), occupied, remaining: round1(p.totalTons - occupied) };
      })
  );

  // 某车辆某时段是否已有计划（同一车辆同一时段只接一趟）
  function slotTaken(vehicleId: string, date: string, slot: Slot, excludePlanId?: string) {
    return plans.value.some((p) => p.vehicleId === vehicleId && p.date === date && p.slot === slot && p.id !== excludePlanId);
  }

  // 某需求当前可承运的待发车计划（油品一致、车辆可运、尚有额度）
  function candidatePlans(requestId: string) {
    const station = stationById(requestId);
    if (!station) return [];
    return availablePlans.value.filter(
      (entry) =>
        entry.plan.fuel === station.fuel &&
        entry.vehicle?.fuels.includes(station.fuel) &&
        entry.remaining > 0
    );
  }

  // ---------- 日志 ----------

  function addLog(level: LogEntry["level"], message: string) {
    logs.value = [{ id: uid("log"), level, message, createdAt: new Date().toISOString() }, ...logs.value].slice(0, 100);
  }

  // ---------- 登记 ----------

  function addStation(input: Omit<Station, "id" | "createdAt">): { ok: boolean; error?: string } {
    if (!input.name || !input.fuel) return { ok: false, error: "请选择油站和所需油品" };
    if (input.neededTons <= 0) return { ok: false, error: "所需油品吨数需大于 0" };
    if (input.backupTons < 0) return { ok: false, error: "备用库存不能为负" };
    if (input.backupTons > input.neededTons) return { ok: false, error: "备用库存不应超过所需量" };
    stations.value = [
      { ...input, id: uid("st"), createdAt: new Date().toISOString() },
      ...stations.value
    ];
    addLog("info", `${input.name} 登记${input.fuel}需求：缺口 ${input.neededTons - input.backupTons} 吨（${input.note || "无备注"}）`);
    return { ok: true };
  }

  function removeStation(id: string) {
    if (allocations.value.some((a) => a.requestId === id && isActive(a))) {
      return { ok: false, error: "该需求存在占用中的分配，请先送达、释放或回收" };
    }
    const station = stationById(id);
    stations.value = stations.value.filter((s) => s.id !== id);
    addLog("warn", `${station?.name ?? "油站"} 的需求登记已删除`);
    return { ok: true };
  }

  // ---------- 车辆与计划 ----------

  function addVehicle(input: { plate: string; capacityTons: number; fuels: Fuel[] }): { ok: boolean; error?: string } {
    const plate = input.plate.trim();
    if (!plate) return { ok: false, error: "请填写车牌" };
    if (input.capacityTons <= 0) return { ok: false, error: "载重需大于 0" };
    if (input.fuels.length === 0) return { ok: false, error: "至少选择一种可运油品" };
    vehicles.value = [...vehicles.value, { ...input, plate, id: uid("veh") }];
    addLog("info", `车辆 ${plate} 入库，载重 ${input.capacityTons} 吨`);
    return { ok: true };
  }

  function addPlan(input: ManualPlanInput): { ok: boolean; error?: string } {
    const vehicle = vehicleById(input.vehicleId);
    if (!vehicle) return { ok: false, error: "请选择车辆" };
    if (!input.fuel) return { ok: false, error: "请选择油品" };
    // 油品不符退回
    if (!vehicle.fuels.includes(input.fuel)) {
      return { ok: false, error: `油品不符：${vehicle.plate} 不可承运 ${input.fuel}` };
    }
    if (input.totalTons <= 0) return { ok: false, error: "配送吨数需大于 0" };
    // 载重不足退回
    if (input.totalTons > vehicle.capacityTons) {
      return {
        ok: false,
        error: `载重不足：${input.totalTons} 吨超出 ${vehicle.plate} 载重 ${vehicle.capacityTons} 吨，缺口 ${round1(input.totalTons - vehicle.capacityTons)} 吨`
      };
    }
    // 同一车辆同一时段只接一趟
    if (slotTaken(input.vehicleId, input.date, input.slot)) {
      return { ok: false, error: `${vehicle.plate} 在 ${input.date} ${input.slot} 已排一趟，请更换时段` };
    }
    plans.value = [
      { ...input, id: uid("plan"), status: "待发车", createdAt: new Date().toISOString() },
      ...plans.value
    ];
    addLog("info", `新建配送计划：${vehicle.plate} 承运 ${input.fuel} ${input.totalTons} 吨（${input.date} ${input.slot}）`);
    return { ok: true };
  }

  function flowPlan(id: string) {
    const plan = planById(id);
    if (!plan) return;
    const order: PlanStatus[] = ["待发车", "运输中", "已到站"];
    const idx = order.indexOf(plan.status);
    const next = order[Math.min(idx + 1, order.length - 1)];
    plan.status = next;
    const vehicle = vehicleById(plan.vehicleId);
    addLog("info", `${vehicle?.plate ?? "车辆"} 的 ${plan.fuel} ${plan.totalTons} 吨计划流转为「${next}」`);
  }

  // ---------- 分配 ----------

  // 登记一条退回（载重不足 / 油品不符 / 无可用计划），写明缺口
  function rejectAllocation(input: { requestId: string; planId: string | null; tons: number; reason: string }) {
    const station = stationById(input.requestId);
    allocations.value = [
      {
        id: uid("al"),
        requestId: input.requestId,
        planId: input.planId,
        vehicleId: planById(input.planId)?.vehicleId ?? null,
        fuel: station?.fuel ?? ("92号汽油" as Fuel),
        tons: round1(input.tons),
        status: "已退回",
        reason: input.reason,
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString()
      },
      ...allocations.value
    ];
  }

  function allocate(input: AllocationInput): { ok: boolean; error?: string; allocated?: number } {
    const station = stationById(input.requestId);
    if (!station) return { ok: false, error: "需求不存在" };
    const want = round1(input.tons);
    if (want <= 0) return { ok: false, error: "分配吨数需大于 0" };

    const open = openGapOf(station);
    if (open <= 0) return { ok: false, error: "该需求已无待分配缺口" };

    // 无可用计划：登记退回并写明缺口，不占用任何额度
    if (!input.planId) {
      const tons = Math.min(want, open);
      rejectAllocation({
        requestId: station.id,
        planId: null,
        tons,
        reason: input.reason || `无可用配送计划，缺口 ${open} 吨待补`
      });
      addLog("warn", `${station.name} ${station.fuel} 分配被退回：无可用计划，缺口 ${open} 吨`);
      return { ok: false, error: `无可用计划，已登记缺口 ${open} 吨` };
    }

    const entry = availablePlans.value.find((e) => e.plan.id === input.planId);
    if (!entry || !entry.vehicle) {
      return { ok: false, error: "该计划已发车或已到站，额度不可再分配" };
    }
    const plan = entry.plan;
    const vehicle = entry.vehicle;

    // 油品不符退回并写明缺口
    if (plan.fuel !== station.fuel) {
      const reason = `油品不符：计划为${plan.fuel}，需求为${station.fuel}，缺口 ${open} 吨`;
      rejectAllocation({ requestId: station.id, planId: plan.id, tons: want, reason });
      addLog("warn", `${station.name} 分配退回：${reason}`);
      return { ok: false, error: reason };
    }
    if (!vehicle.fuels.includes(station.fuel)) {
      const reason = `油品不符：${vehicle.plate} 不可承运 ${station.fuel}，缺口 ${open} 吨`;
      rejectAllocation({ requestId: station.id, planId: plan.id, tons: want, reason });
      addLog("warn", `${station.name} 分配退回：${reason}`);
      return { ok: false, error: reason };
    }

    // 该需求实际想切的量（不超过自身待分配缺口）与该趟车还能装的量
    const effectiveWant = round1(Math.min(want, open));
    const loadableByCapacity = round1(Math.max(0, entry.vehicle.capacityTons - occupiedOf(plan.id)));
    const capacity = round1(Math.min(entry.remaining, loadableByCapacity));
    const tons = round1(Math.min(effectiveWant, capacity));

    // 载重不足：车辆剩余载重装不下全部申请量，能装多少装多少，差额退回写明缺口
    const shortage = round1(effectiveWant - tons);
    let note = "";
    if (shortage > 0) {
      if (loadableByCapacity < entry.remaining) {
        note = `载重不足：${entry.vehicle.plate} 仅能再装 ${loadableByCapacity} 吨，缺口 ${shortage} 吨`;
      } else {
        note = `计划余量不足：该趟仅余 ${entry.remaining} 吨，缺口 ${shortage} 吨待补`;
      }
    }
    if (tons <= 0) {
      rejectAllocation({ requestId: station.id, planId: plan.id, tons: effectiveWant, reason: note });
      addLog("warn", `${station.name} 分配退回：${note}`);
      return { ok: false, error: note };
    }

    allocations.value = [
      {
        id: uid("al"),
        requestId: station.id,
        planId: plan.id,
        vehicleId: entry.vehicle.id,
        fuel: station.fuel,
        tons,
        status: ACTIVE_ALLOCATION,
        reason: note || input.reason || `已从 ${plan.date} ${plan.slot} 计划切出额度`,
        createdAt: new Date().toISOString(),
        decidedAt: null
      },
      ...allocations.value
    ];
    addLog(
      shortage > 0 ? "warn" : "ok",
      `${station.name} 分配到 ${entry.vehicle.plate}：${station.fuel} ${tons} 吨` +
        (shortage > 0 ? `；${note}` : "")
    );
    if (shortage > 0) {
      rejectAllocation({
        requestId: station.id,
        planId: plan.id,
        tons: shortage,
        reason: note
      });
    }
    return { ok: true, allocated: tons, error: shortage > 0 ? note : undefined };
  }

  // 按优先级自动分配：特急 > 加急 > 常规，同级按登记时间；贪心切额度
  function autoAllocate() {
    const sorted = [...stations.value]
      .filter((s) => openGapOf(s) > 0)
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

    let matched = 0;
    let covered = 0;
    let shortTons = 0;
    for (const station of sorted) {
      let open = openGapOf(station);
      const options = candidatePlans(station.id)
        .slice()
        .sort((a, b) => a.plan.date.localeCompare(b.plan.date) || a.plan.slot.localeCompare(b.plan.slot));
      for (const entry of options) {
        if (open <= 0) break;
        const tons = round1(Math.min(open, entry.remaining));
        if (tons <= 0) continue;
        const result = allocate({ requestId: station.id, planId: entry.plan.id, tons });
        if (result.ok) {
          matched++;
          covered += result.allocated ?? 0;
          open = openGapOf(station);
        }
      }
      const still = openGapOf(station);
      if (still > 0) {
        rejectAllocation({
          requestId: station.id,
          planId: null,
          tons: still,
          reason: `自动分配后仍无可用计划/额度，缺口 ${still} 吨`
        });
        shortTons += still;
        addLog("warn", `${station.name} ${station.fuel} 尚有 ${still} 吨缺口未覆盖`);
      }
    }
    if (matched === 0 && shortTons === 0) addLog("info", "自动分配：所有需求均已覆盖，无需操作");
    else addLog("ok", `自动分配完成：切出 ${matched} 笔共 ${round1(covered)} 吨，未覆盖 ${round1(shortTons)} 吨`);
    return { matched, covered: round1(covered), shortTons: round1(shortTons) };
  }

  // ---------- 送达 / 释放 / 回收 ----------

  // 实际送达：核减缺口（备用库存增加），释放占用额度
  function confirmDelivery(id: string, deliveredTons?: number) {
    const allocation = allocations.value.find((a) => a.id === id);
    if (!allocation || !isActive(allocation)) return { ok: false, error: "仅占用中的分配可确认送达" };
    const station = stationById(allocation.requestId);
    const tons = round1(Math.min(deliveredTons ?? allocation.tons, allocation.tons));
    if (tons <= 0) return { ok: false, error: "送达吨数需大于 0" };

    allocation.status = "已送达";
    allocation.decidedAt = new Date().toISOString();
    if (station) {
      station.backupTons = round1(Math.min(station.neededTons, station.backupTons + tons));
      allocation.reason = `已送达核减：${station.name} 备用库存 +${tons} 吨，额度已释放`;
    }
    const vehicle = vehicleById(allocation.vehicleId);
    addLog("ok", `${station?.name ?? "油站"} 实收 ${vehicle?.plate ?? "车辆"} ${allocation.fuel} ${tons} 吨，缺口核减、额度释放`);
    return { ok: true, tons };
  }

  // 调度员主动释放（计划取消等）：占用回到待分配
  function releaseAllocation(id: string, reason = "调度释放") {
    const allocation = allocations.value.find((a) => a.id === id);
    if (!allocation || !isActive(allocation)) return { ok: false, error: "仅占用中的分配可释放" };
    allocation.status = "已回收";
    allocation.decidedAt = new Date().toISOString();
    allocation.reason = reason;
    const station = stationById(allocation.requestId);
    addLog("warn", `${station?.name ?? "油站"} 的 ${allocation.tons} 吨占用已释放，回到待分配（${reason}）`);
    return { ok: true };
  }

  // 超过一天未送达：占用自动回到待分配
  function sweepTimedOut(now = Date.now()): number {
    let count = 0;
    let tons = 0;
    for (const a of allocations.value) {
      if (isActive(a) && now - new Date(a.createdAt).getTime() > TIMEOUT_MS) {
        a.status = "已回收";
        a.decidedAt = new Date().toISOString();
        a.reason = "超过一天未确认送达，占用自动回到待分配";
        count++;
        tons += a.tons;
      }
    }
    if (count > 0) addLog("warn", `超时回收 ${count} 笔共 ${round1(tons)} 吨占用，额度回到待分配`);
    return count;
  }

  // ---------- 指标 ----------

  const metrics = computed(() => {
    const totalGap = round1(stations.value.reduce((sum, s) => sum + gapOf(s), 0));
    const activeTons = round1(allocations.value.filter(isActive).reduce((sum, a) => sum + a.tons, 0));
    const coveredGap = round1(stations.value.reduce((sum, s) => sum + Math.min(activeTonsOf(s.id), gapOf(s)), 0));
    const deliveredTons = round1(
      allocations.value.filter((a) => a.status === "已送达").reduce((sum, a) => sum + a.tons, 0)
    );
    const shortRejections = allocations.value.filter((a) => a.status === "已退回").length;
    const availableTons = round1(availablePlans.value.reduce((sum, e) => sum + e.remaining, 0));
    return {
      totalGap,
      activeTons,
      coveredGap,
      openGap: round1(Math.max(0, totalGap - coveredGap)),
      deliveredTons,
      shortRejections,
      availableTons,
      activeCount: allocations.value.filter(isActive).length
    };
  });

  return {
    // state
    stations,
    vehicles,
    plans,
    allocations,
    logs,
    // getters / queries
    availablePlans,
    metrics,
    vehicleById,
    planById,
    stationById,
    gapOf,
    activeTonsOf,
    openGapOf,
    occupiedOf,
    slotTaken,
    candidatePlans,
    // actions
    addStation,
    removeStation,
    addVehicle,
    addPlan,
    flowPlan,
    allocate,
    rejectAllocation,
    autoAllocate,
    confirmDelivery,
    releaseAllocation,
    sweepTimedOut,
    addLog
  };
});

export { ALLOCATION_STATUSES };
export type { Priority };
