import { defineStore } from "pinia";
import {
  FUELS,
  STORAGE_KEY,
  STALE_LIMIT_MS,
  gapOf,
  now,
  round1,
  uid
} from "./constants";
import type {
  Allocation,
  Demand,
  Fuel,
  Plan,
  Priority,
  Vehicle
} from "./types";

interface State {
  vehicles: Vehicle[];
  demands: Demand[];
  plans: Plan[];
  allocations: Allocation[];
}

interface AllocateResult {
  ok: boolean;
  message: string;
  allocationId?: string;
}

const SEED_VEHICLES: Vehicle[] = [
  {
    id: "v-01",
    name: "鲁B·A102 油罐车",
    capacity: 20,
    fuels: ["92号汽油", "95号汽油"],
    slots: ["2026-09-24 上午", "2026-09-24 下午", "2026-09-25 上午"],
    notes: "城东站方向常用车"
  },
  {
    id: "v-02",
    name: "鲁B·D308 油罐车",
    capacity: 15,
    fuels: ["0号柴油", "-10号柴油"],
    slots: ["2026-09-24 上午", "2026-09-24 下午", "2026-09-25 上午"],
    notes: "柴油专车"
  },
  {
    id: "v-03",
    name: "鲁B·F715 小型油罐车",
    capacity: 8,
    fuels: FUELS,
    slots: ["2026-09-24 上午", "2026-09-24 下午", "2026-09-25 上午"],
    notes: "小吨位灵活补站"
  }
];

const SEED_DEMANDS: Demand[] = [
  {
    id: "d-01",
    station: "城东站",
    fuel: "92号汽油",
    backup: 6,
    required: 30,
    priority: 1,
    incident: "片区临时停电，加油机仅靠自备电运行，预计24小时内恢复",
    contact: "王站长 138****0101",
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString()
  },
  {
    id: "d-02",
    station: "机场站",
    fuel: "0号柴油",
    backup: 4,
    required: 16,
    priority: 2,
    incident: "进场路封闭施工，需绕行北线，重车限行",
    contact: "李站长 138****0202",
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString()
  },
  {
    id: "d-03",
    station: "新区站",
    fuel: "95号汽油",
    backup: 9,
    required: 12,
    priority: 3,
    incident: "周边道路阶段性管制，提前备货",
    contact: "赵站长 138****0303",
    createdAt: new Date(Date.now() - 1 * 3600_000).toISOString()
  }
];

const SEED_PLANS: Plan[] = [
  {
    id: "p-01",
    code: "PS-240924-01",
    vehicleId: "v-01",
    slot: "2026-09-24 上午",
    fuel: "92号汽油",
    tons: 18,
    station: "城东站",
    planArriveAt: "2026-09-24",
    status: "运输中",
    departedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    notes: "常规补货，车辆已出库",
    createdAt: new Date(Date.now() - 8 * 3600_000).toISOString()
  },
  {
    id: "p-02",
    code: "PS-240924-02",
    vehicleId: "v-02",
    slot: "2026-09-24 下午",
    fuel: "0号柴油",
    tons: 12,
    station: "机场站",
    planArriveAt: "2026-09-24",
    status: "待发车",
    notes: "等待装车",
    createdAt: new Date(Date.now() - 4 * 3600_000).toISOString()
  },
  {
    id: "p-03",
    code: "PS-240924-03",
    vehicleId: "v-03",
    slot: "2026-09-24 下午",
    fuel: "92号汽油",
    tons: 8,
    station: "城东站",
    planArriveAt: "2026-09-24",
    status: "待发车",
    notes: "小车应急补站",
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString()
  }
];

export const useDispatchStore = defineStore("emergency-dispatch", {
  state: (): State => ({
    vehicles: [],
    demands: [],
    plans: [],
    allocations: []
  }),

  getters:
    {
      vehicleMap(state): Record<string, Vehicle> {
        return Object.fromEntries(state.vehicles.map((v) => [v.id, v]));
      },

      /** 需求 -> 占额明细（按需求） */
      allocationsByDemand(state): Record<string, Allocation[]> {
        const map: Record<string, Allocation[]> = {};
        for (const a of state.allocations) {
          (map[a.demandId] ??= []).push(a);
        }
        return map;
      },

      allocationsByPlan(state): Record<string, Allocation[]> {
        const map: Record<string, Allocation[]> = {};
        for (const a of state.allocations) {
          (map[a.planId] ??= []).push(a);
        }
        return map;
      }
    },

  actions: {
    /* ---------------- 持久化 ---------------- */

    load() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const data = JSON.parse(raw) as State;
          this.vehicles = data.vehicles ?? [];
          this.demands = data.demands ?? [];
          this.plans = data.plans ?? [];
          this.allocations = data.allocations ?? [];
          this.reclaimStale();
          return;
        } catch {
          // 数据损坏则回落到演示数据
        }
      }
      this.vehicles = structuredClone(SEED_VEHICLES);
      this.demands = structuredClone(SEED_DEMANDS);
      this.plans = structuredClone(SEED_PLANS);
      this.allocations = [];
      this.persist();
    },

    persist() {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          vehicles: this.vehicles,
          demands: this.demands,
          plans: this.plans,
          allocations: this.allocations
        } satisfies State)
      );
    },

    resetDemo() {
      localStorage.removeItem(STORAGE_KEY);
      this.load();
    },

    /* ---------------- 派生数据（方法形式，参数化） ---------------- */

    /** 该需求仍在途/待发的有效占额合计（已发车、已到站计划的占额不算占用可分配额度？——
     *  业务上油量已在途是“保供中”，仍计入保供进度，但不再占用“可分配额度池”。
     *  这里区分两个口径。） */

    activeAllocations(demandId: string): Allocation[] {
      return this.allocations.filter(
        (a) =>
          a.demandId === demandId &&
          (a.status === "待发车" || a.status === "运输中")
      );
    },

    /** 已核减库存（实际送达）合计 */
    deliveredTons(demandId: string): number {
      return round1(
        this.allocations
          .filter((a) => a.demandId === demandId && a.status === "已送达")
          .reduce((s, a) => s + (a.deliveredTons ?? a.tons), 0)
      );
    },

    /** 在途油量（运输中，含已发车） */
    inboundTons(demandId: string): number {
      return round1(
        this.allocations
          .filter((a) => a.demandId === demandId && a.status === "运输中")
          .reduce((s, a) => s + a.tons, 0)
      );
    },

    /**
     * 待发占额：仍可被退回/回收的部分。
     * “已发车或已到站的油量不再占用”——发车后的油量进入保供在途，
     * 不再占用待分配额度，也不允许再退回给其他需求。
     */
    pendingTons(demandId: string): number {
      return round1(
        this.allocations
          .filter((a) => a.demandId === demandId && a.status === "待发车")
          .reduce((s, a) => s + a.tons, 0)
      );
    },

    /** 剩余待分配缺口 = 总缺口 - 已送达 - 在途 - 待发占额 */
    remainingGap(demandId: string): number {
      const d = this.demands.find((x) => x.id === demandId);
      if (!d) return 0;
      const covered =
        this.deliveredTons(demandId) +
        this.inboundTons(demandId) +
        this.pendingTons(demandId);
      return Math.max(0, round1(gapOf(d) - covered));
    },

    demandStatus(d: Demand): string {
      const delivered = this.deliveredTons(d.id);
      const gap = gapOf(d);
      if (delivered + 1e-6 >= gap) return "已完成";
      if (this.activeAllocations(d.id).length > 0) {
        return delivered > 0 || this.inboundTons(d.id) > 0
          ? "保供中"
          : "部分已配";
      }
      return "待分配";
    },

    /* ---------------- 配送计划可用额度 ---------------- */

    plan(planId: string): Plan | undefined {
      return this.plans.find((p) => p.id === planId);
    },

    /**
     * 计划的“可分配额度”。
     * - 待发车：总吨数 - 该计划上所有 待发车 占额；
     * - 运输中/已到站：油量已发车/到站，不再占用待分配池，可用额度为 0。
     */
    availableTons(planId: string): number {
      const p = this.plan(planId);
      if (!p || p.status !== "待发车") return 0;
      const occupied = this.allocations
        .filter((a) => a.planId === planId && a.status === "待发车")
        .reduce((s, a) => s + a.tons, 0);
      return Math.max(0, round1(p.tons - occupied));
    },

    /** 同一车辆在同一时段是否已有占额（一车一时段一趟） */
    vehicleSlotTaken(vehicleId: string, slot: string, ignorePlanId?: string): Plan | undefined {
      return this.plans.find((p) => {
        if (p.vehicleId !== vehicleId || p.slot !== slot) return false;
        if (ignorePlanId && p.id === ignorePlanId) return false;
        // 该时段该车已有“在途/待发”的计划即视为占用
        return p.status === "待发车" || p.status === "运输中";
      });
    },

    /* ---------------- 分配（核心规则） ---------------- */

    /**
     * 按优先级自动分配：一级 > 二级 > 三级，同级先登记先处理。
     * 仅从“待发车”的可用配送计划中取量；
     * 油品必须一致；车辆载重不足（可用额度小于需求）按可给量分配并标注剩余缺口；
     * 同一车辆同一时段只接一趟（通过计划本身的车辆+时段约束）。
     */
    autoAllocate(): { allocated: number; lines: string[] } {
      this.reclaimStale();
      const lines: string[] = [];
      let count = 0;

      const queue = [...this.demands]
        .filter((d) => this.remainingGap(d.id) > 0.05)
        .sort(
          (a, b) =>
            a.priority - b.priority ||
            a.createdAt.localeCompare(b.createdAt)
        );

      for (const demand of queue) {
        // 可用计划：油品一致、待发车、仍有额度
        const candidates = this.plans
          .filter(
            (p) =>
              p.status === "待发车" &&
              p.fuel === demand.fuel &&
              this.availableTons(p.id) > 0.05
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        for (const plan of candidates) {
          const remaining = this.remainingGap(demand.id);
          if (remaining <= 0.05) break;
          const give = Math.min(remaining, this.availableTons(plan.id));
          if (give <= 0.05) continue;
          const res = this.allocate(demand.id, plan.id, give);
          if (res.ok) {
            count++;
            lines.push(
              `${demand.station}·${demand.fuel} ← ${plan.code}（${this.vehicleMap[plan.vehicleId]?.name ?? "车辆"}）${round1(give)} 吨`
            );
          } else {
            lines.push(`${demand.station}·${demand.fuel}：${res.message}`);
          }
        }
        const left = this.remainingGap(demand.id);
        if (left > 0.05) {
          lines.push(
            `⚠ ${demand.station}·${demand.fuel} 仍有 ${left} 吨缺口，无符合油品的可用运力`
          );
        }
      }
      this.persist();
      return { allocated: count, lines };
    },

    /** 手工分配：调度员指定需求、计划、吨数，系统校验并写明退回原因 */
    allocate(demandId: string, planId: string, tons: number): AllocateResult {
      const demand = this.demands.find((d) => d.id === demandId);
      const plan = this.plan(planId);
      if (!demand || !plan) return { ok: false, message: "需求或配送计划不存在" };

      const t = round1(tons);
      if (!(t > 0)) return { ok: false, message: "分配吨数必须大于 0" };

      // 规则 1：油品不符直接退回
      if (plan.fuel !== demand.fuel) {
        return {
          ok: false,
          message: `油品不符：计划载运 ${plan.fuel}，需求为 ${demand.fuel}，缺口 ${this.remainingGap(demandId)} 吨未解决`
        };
      }

      // 规则 2：已发车/已到站的油量不再参与占用
      if (plan.status !== "待发车") {
        return { ok: false, message: `计划 ${plan.code} 已${plan.status}，油量不可再分配` };
      }

      // 规则 3：车辆载重/剩余额度不足：退回超出部分并写明缺口
      const available = this.availableTons(planId);
      if (available <= 0.05) {
        return {
          ok: false,
          message: `${this.vehicleMap[plan.vehicleId]?.name ?? "车辆"} 该趟 ${plan.slot} 额度已占满，载重 ${plan.tons} 吨不足`
        };
      }

      const remainingGap = this.remainingGap(demandId);
      if (remainingGap <= 0.05) {
        return { ok: false, message: "该需求缺口已覆盖，无需再分配" };
      }

      // 一车一时段一趟：该计划已隐含车辆+时段；检查同车同时段是否还有其他活跃计划被占用
      const conflict = this.vehicleSlotTaken(plan.vehicleId, plan.slot, plan.id);
      if (conflict) {
        return {
          ok: false,
          message: `同一车辆 ${plan.slot} 已有一趟任务（${conflict.code}），不能再接`
        };
      }

      const give = round1(Math.min(t, available, remainingGap));
      const shortageOnVehicle = t - give; // 车辆给不出的部分

      const allocation: Allocation = {
        id: uid("a-"),
        demandId,
        planId,
        tons: give,
        status: "待发车",
        createdAt: now()
      };
      if (shortageOnVehicle > 0.05) {
        allocation.reason = `车辆载重/剩余额度不足，申请 ${round1(t)} 吨仅承运 ${give} 吨，缺口 ${round1(shortageOnVehicle)} 吨需另派运力`;
      }
      this.allocations.push(allocation);
      this.persist();
      return {
        ok: true,
        allocationId: allocation.id,
        message:
          shortageOnVehicle > 0.05
            ? `已配 ${give} 吨，车辆载重不足，另缺 ${round1(shortageOnVehicle)} 吨`
            : `已分配 ${give} 吨`
      };
    },

    /** 退回占额：载重不足/油品不符等，写明缺口；仅待发车占额可退 */
    rejectAllocation(allocationId: string, reason: string) {
      const a = this.allocations.find((x) => x.id === allocationId);
      if (!a || a.status !== "待发车") return;
      a.status = "已退回";
      a.reason = reason || "调度退回，油量回到待分配";
      this.persist();
    },

    /* ---------------- 计划流转 ---------------- */

    /** 发车：占额转入运输中；油量不再占用可分配额度（但仍计入保供在途） */
    departPlan(planId: string) {
      const p = this.plan(planId);
      if (!p || p.status !== "待发车") return;
      p.status = "运输中";
      p.departedAt = now();
      const ts = p.departedAt;
      for (const a of this.allocations) {
        if (a.planId === planId && a.status === "待发车") {
          a.status = "运输中";
          a.departedAt = ts;
        }
      }
      this.persist();
    },

    /**
     * 实际送达：核减库存（登记为已送达量）、释放该趟车辆额度；
     * 支持短卸（实收 < 占额），短卸差额回到待分配。
     */
    arrivePlan(planId: string, delivered?: number) {
      const p = this.plan(planId);
      if (!p || p.status !== "运输中") return;
      p.status = "已到站";
      p.arrivedAt = now();
      for (const a of this.allocations) {
        if (a.planId === planId && a.status === "运输中") {
          const real = delivered === undefined ? a.tons : Math.min(a.tons, round1(delivered));
          a.status = "已送达";
          a.deliveredAt = p.arrivedAt;
          a.deliveredTons = real;
          if (real + 0.05 < a.tons) {
            a.reason = `短卸 ${round1(a.tons - real)} 吨，差额回到待分配`;
          }
        }
      }
      this.persist();
    },

    /**
     * 超过一天未送达的占用回到待分配：
     * 待发车占额自创建起超过 24h（运输中自发车起超过 24h 且未到站）→ 回收。
     * 回收后计划额度释放，需求缺口重新暴露。
     */
    reclaimStale(): number {
      const t = Date.now();
      let n = 0;
      for (const a of this.allocations) {
        if (a.status !== "待发车" && a.status !== "运输中") continue;
        const since =
          a.status === "运输中"
            ? a.departedAt ?? a.createdAt
            : a.createdAt;
        if (t - new Date(since).getTime() > STALE_LIMIT_MS) {
          a.status = "已回收";
          a.reason = `超过一天未送达，系统自动回收，油量回到待分配（${new Date(since).toLocaleString("zh-CN")} 起）`;
          // 若计划仍标运输中但占额被回收，计划回退为待发车以便重新派车
          const p = this.plan(a.planId);
          if (p && p.status === "运输中") {
            p.status = "待发车";
            p.departedAt = undefined;
          }
          n++;
        }
      }
      if (n > 0) this.persist();
      return n;
    },

    /* ---------------- 登记与维护 ---------------- */

    addVehicle(v: Omit<Vehicle, "id">): Vehicle {
      const vehicle: Vehicle = { ...v, id: uid("v-") };
      this.vehicles.push(vehicle);
      this.persist();
      return vehicle;
    },

    addDemand(d: Omit<Demand, "id" | "createdAt">): Demand {
      const demand: Demand = { ...d, id: uid("d-"), createdAt: now() };
      this.demands.push(demand);
      this.persist();
      return demand;
    },

    addPlan(p: Omit<Plan, "id" | "code" | "createdAt" | "status">): Plan {
      const vehicle = this.vehicles.find((v) => v.id === p.vehicleId);
      const plan: Plan = {
        ...p,
        id: uid("p-"),
        code: `PS-${new Date().toISOString().slice(0, 10).replace(/-/g, "").slice(4)}-${String(this.plans.length + 1).padStart(2, "0")}`,
        status: "待发车",
        createdAt: now()
      };
      // 油品与载重校验
      if (vehicle) {
        if (!vehicle.fuels.includes(p.fuel)) {
          plan.notes = `⚠ 该车辆不具备 ${p.fuel} 运输资质`;
        } else if (p.tons > vehicle.capacity) {
          plan.notes = `⚠ 配载 ${p.tons} 吨超过核定载重 ${vehicle.capacity} 吨`;
        }
      }
      this.plans.push(plan);
      this.persist();
      return plan;
    },

    removeDemand(id: string) {
      this.demands = this.demands.filter((d) => d.id !== id);
      this.allocations = this.allocations.filter((a) => a.demandId !== id);
      this.persist();
    },

    removePlan(id: string) {
      const active = this.allocations.some(
        (a) => a.planId === id && (a.status === "待发车" || a.status === "运输中")
      );
      if (active) return false;
      this.plans = this.plans.filter((p) => p.id !== id);
      this.allocations = this.allocations.filter((a) => a.planId !== id);
      this.persist();
      return true;
    }
  }
});

export type { Fuel, Priority };
