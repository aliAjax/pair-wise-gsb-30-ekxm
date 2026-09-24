// 应急保供调度台：领域模型定义

export const FUELS = ["92号汽油", "95号汽油", "柴油"] as const;
export type Fuel = (typeof FUELS)[number];

export const STATIONS = ["城东站", "机场站", "新区站", "高新园站"] as const;
export type StationName = (typeof STATIONS)[number];

// 配送计划可分配状态；已发车、已到站不再占用可分配额度
export const PLAN_STATUSES = ["待发车", "运输中", "已到站"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

// 占用中：已从可用计划中切出额度；已退回：车辆载重不足/油品不符；
// 已送达：站点确认收货，已核减缺口并释放额度；已回收：超过一天未送达，额度回到待分配
export const ALLOCATION_STATUSES = ["占用中", "已送达", "已退回", "已回收"] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const ACTIVE_ALLOCATION: AllocationStatus = "占用中";

export const PRIORITIES = [1, 2, 3] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  1: { label: "特急", color: "#c84b31" },
  2: { label: "加急", color: "#d98a1f" },
  3: { label: "常规", color: "#176b87" }
};

// 以半天为一个配送时段，同一车辆同一时段只接一趟
export const SLOTS = ["上午", "下午", "夜间"] as const;
export type Slot = (typeof SLOTS)[number];

export interface Station {
  id: string;
  name: StationName;
  fuel: Fuel;
  backupTons: number; // 备用库存（吨）
  neededTons: number; // 所需油品（吨）
  priority: Priority;
  note: string;
  createdAt: string;
}

export interface Vehicle {
  id: string;
  plate: string;
  capacityTons: number;
  fuels: Fuel[]; // 可运油品（油品不符即不可承运）
}

export interface DeliveryPlan {
  id: string;
  vehicleId: string;
  fuel: Fuel;
  totalTons: number; // 计划总量
  date: string; // 计划日期 YYYY-MM-DD
  slot: Slot;
  status: PlanStatus;
  createdAt: string;
}

export interface Allocation {
  id: string;
  requestId: string; // 对应油站需求登记
  planId: string | null; // 退回且无可用计划时为空
  vehicleId: string | null;
  fuel: Fuel;
  tons: number;
  status: AllocationStatus;
  reason: string; // 退回原因 / 操作说明
  createdAt: string;
  decidedAt: string | null; // 送达、退回、回收时间
}

export interface LogEntry {
  id: string;
  level: "info" | "warn" | "ok";
  message: string;
  createdAt: string;
}

export interface DispatchState {
  stations: Station[];
  vehicles: Vehicle[];
  plans: DeliveryPlan[];
  allocations: Allocation[];
  logs: LogEntry[];
}

// 占用中的额度才算"占用"；已发车/已到站的计划随状态流转天然退出可分配池
export function isActive(a: Allocation): boolean {
  return a.status === ACTIVE_ALLOCATION;
}
