export function formatTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 占用已持续时间（用于提示距 24 小时超时）
export function ageHours(iso: string, now = Date.now()) {
  return Math.max(0, round1((now - new Date(iso).getTime()) / 3600000));
}

export function round1(value: number) {
  return Math.round(value * 10) / 10;
}
