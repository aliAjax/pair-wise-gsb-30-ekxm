// 应急保供调度台领域模型

export type Fuel = "92号汽油" | "95号汽油" | "0号柴油" | "-10号柴油";

/** 保供优先级：数字越小越紧急 */
export type Priority = 1 | 2 | 3;

/** 配送计划状态：待发车 -> 运输中 -> 已到站 */
export type PlanStatus = "待发车" | "运输中" | "已到站";

/** 油站保供需求状态 */
export type DemandStatus = "待分配" | "部分已配" | "保供中" | "已完成";

/** 分配（占额）记录状态 */
export type AllocationStatus = "待发车" | "运输中" | "已送达" | "已退回" | "已回收";

export interface Vehicle {
  id: string;
  name: string;
  /** 核定载重（吨） */
  capacity: number;
  /** 可承运油品 */
  fuels: Fuel[];
  /** 可执行时段，如 ["2026-09-24 上午", "2026-09-24 下午"]；同一时段只能接一趟 */
  slots: string[];
  notes?: string;
}

export interface Demand {
  id: string;
  station: string;
  fuel: Fuel;
  /** 备用库存（吨） */
  backup: number;
  /** 保供所需油量（吨） */
  required: number;
  priority: Priority;
  /** 停电/封路等事件说明 */
  incident: string;
  contact: string;
  createdAt: string;
}

export interface Plan {
  id: string;
  code: string;
  vehicleId: string;
  /** 执行时段，与车辆 slot 对应，用于同车同时段冲突校验 */
  slot: string;
  fuel: Fuel;
  /** 计划发油量（吨），受车辆载重限制 */
  tons: number;
  station: string;
  planArriveAt: string;
  status: PlanStatus;
  departedAt?: string;
  arrivedAt?: string;
  notes?: string;
  createdAt: string;
}

export interface Allocation {
  id: string;
  demandId: string;
  planId: string;
  /** 分配占用的油量（吨） */
  tons: number;
  status: AllocationStatus;
  /** 退回时写明的缺口/原因 */
  reason?: string;
  createdAt: string;
  departedAt?: string;
  deliveredAt?: string;
  /** 实际送达吨数（可能短卸） */
  deliveredTons?: number;
}
