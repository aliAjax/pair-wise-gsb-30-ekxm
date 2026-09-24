import { setActivePinia, createPinia } from "pinia";
import { useDispatchStore } from "../src/store";
import { gapOf } from "../src/constants";

// localStorage 桩
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

setActivePinia(createPinia());
const s = useDispatchStore();
s.load();

const d1 = s.demands.find((d) => d.station === "城东站"); // 缺口 24，92
const d2 = s.demands.find((d) => d.station === "机场站"); // 缺口 12，0号柴油
const d3 = s.demands.find((d) => d.station === "新区站"); // 缺口 3，95
const p1 = s.plans.find((p) => p.code === "PS-240924-01"); // 运输中 18t 92
const p2 = s.plans.find((p) => p.code === "PS-240924-02"); // 待发车 12t 柴油
const p3 = s.plans.find((p) => p.code === "PS-240924-03"); // 待发车 8t 92

console.log("种子数据缺口:");
assert(gapOf(d1) === 24 && gapOf(d2) === 12 && gapOf(d3) === 3, "缺口 = 所需 - 备用 (24/12/3)");
assert(s.availableTons(p1.id) === 0, "运输中计划可分配额度为 0（已发车油量不再占用池）");
assert(s.availableTons(p2.id) === 12 && s.availableTons(p3.id) === 8, "待发车计划额度 = 发油量");

console.log("按优先级自动分配:");
const r = s.autoAllocate();
console.log("   ", r.lines.join("\n    "));
assert(s.pendingTons(d1.id) === 8, "一级：城东站先从小车计划分得 8 吨");
assert(s.remainingGap(d1.id) === 16, "城东站剩余缺口 16 吨（运输中计划不可再分）");
assert(s.remainingGap(d2.id) === 0, "二级：机场站 12 吨被柴油计划全额覆盖");
assert(s.pendingTons(d3.id) === 0 && s.remainingGap(d3.id) === 3, "三级：无 95 号可用运力，缺口保留 3 吨");
assert(s.availableTons(p3.id) === 0 && s.availableTons(p2.id) === 0, "两计划额度占满");

console.log("规则校验:");
const badFuel = s.allocate(d1.id, p2.id, 5);
assert(!badFuel.ok && badFuel.message.includes("油品不符"), "油品不符直接退回并写明缺口");
const over = s.allocate(d1.id, p3.id, 5);
assert(!over.ok && over.message.includes("已占满"), "载重额度占满时拒绝");

// 释放 p3 后测试载重不足按可给量承运
const aOnP3 = s.allocations.find((a) => a.planId === p3.id && a.status === "待发车");
s.rejectAllocation(aOnP3.id, "测试退回");
assert(s.availableTons(p3.id) === 8, "退回后额度释放回待分配");
const partial = s.allocate(d1.id, p3.id, 20);
assert(partial.ok, "申请量超过可用额度时不整体拒绝");
const newA = s.allocations.find((a) => a.id === partial.allocationId);
assert(newA.tons === 8 && newA.reason?.includes("缺口 12"), "仅承运可用的 8 吨，并写明另缺 12 吨");

console.log("发车 -> 送达核减:");
s.departPlan(p3.id);
assert(newA.status === "运输中", "发车后占额转为运输中");
assert(s.availableTons(p3.id) === 0, "发车后油量不占可分配额度且不可再退");
let rejected = false;
s.rejectAllocation(newA.id, "试图退回");
if (newA.status === "运输中") rejected = true;
assert(rejected, "已发车占额不能退回");

s.arrivePlan(p3.id, 7); // 短卸 1 吨
assert(newA.status === "已送达" && newA.deliveredTons === 7, "登记实际送达 7 吨（短卸）");
assert(s.deliveredTons(d1.id) === 7, "库存按实收 7 吨核减");
assert(s.remainingGap(d1.id) === 17, "短卸 1 吨回到缺口：24 - 7 = 17");

console.log("一车一时段一趟:");
const conflict = s.vehicleSlotTaken(p2.vehicleId, p2.slot, p2.id);
assert(!!conflict && conflict.id !== p2.id || s.plans.some((x) => x.vehicleId === p2.vehicleId && x.slot === p2.slot && x.id !== p2.id) === false, "同车同时段冲突检测可识别");
// 给同车加同时段新计划应被拦截（addPlan 不拦，UI 拦；底层 vehicleSlotTaken 必须返回已存在计划）
assert(s.vehicleSlotTaken(p2.vehicleId, p2.slot)?.id === p2.id, "同车同时段已有活跃计划时判定占用");

console.log("超 24 小时未送达回收:");
// 机场站的占额（p2 仍待发车），把 createdAt 改成 25 小时前
const a2 = s.allocations.find((a) => a.demandId === d2.id && a.status === "待发车");
a2.createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
const n = s.reclaimStale();
assert(n >= 1 && a2.status === "已回收", "超过一天未送达的待发占额自动回收");
assert(a2.reason?.includes("回到待分配"), "回收记录写明原因");
assert(s.availableTons(p2.id) === 12, "回收后计划额度释放");
assert(s.remainingGap(d2.id) === 12, "回收后机场站 12 吨缺口重新暴露");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
