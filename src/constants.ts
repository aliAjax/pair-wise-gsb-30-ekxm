import type { Fuel, PlanStatus, Priority } from "./types";

export const STORAGE_KEY = "hxwlfront-19-emergency-dispatch-v1";

export const FUELS: Fuel[] = ["92号汽油", "95号汽油", "0号柴油", "-10号柴油"];

export const PRIORITY_META: Record<
  Priority,
  { label: string; color: string; bg: string }
> = {
  1: { label: "一级·紧急", color: "#c84b31", bg: "#fdecea" },
  2: { label: "二级·重要", color: "#b7791f", bg: "#fdf3e0" },
  3: { label: "三级·常规", color: "#176b87", bg: "#e6f2f6" }
};

export const PLAN_STATUSES: PlanStatus[] = ["待发车", "运输中", "已到站"];

/** 超过该毫秒数仍未送达的待发车占额自动回到待分配 */
export const STALE_LIMIT_MS = 24 * 60 * 60 * 1000;

export function uid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function gapOf(d: { backup: number; required: number }): number {
  return Math.max(0, round1(d.required - d.backup));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 从 ISO 时间生成“日期 上午/下午”形式的时段 */
export function slotFromDate(date: string, half: "am" | "pm"): string {
  return `${date || "未排期"} ${half === "am" ? "上午" : "下午"}`;
}
