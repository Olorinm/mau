/** What an access record keeps of a request: when, what was asked, the answer and who asked. No query, headers or body. */
export function accessRecord(request, status, startedAt, now = Date.now()) {
  return {
    time: new Date(startedAt).toISOString(),
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    ms: now - startedAt,
    ip: request.headers.get("CF-Connecting-IP") ?? "",
  };
}

/** Access records are written to the bucket in batches: when many wait, or when the oldest has waited ten minutes. */
export function accessBatchDue(waiting, oldestAt, now = Date.now()) {
  return waiting >= 1000 || (waiting > 0 && now - oldestAt >= 10 * 60_000);
}

/** The object an access batch is written to. Records sort by time within and across objects. */
export function accessBatchKey(firstId, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  return `${stamp.slice(0, 10)}/${stamp.slice(11, 19).replaceAll(":", "")}-${String(firstId).padStart(12, "0")}.jsonl`;
}

/** The UTC day a backup is due for: today's from the configured hour on, unless that day's was already made. */
export function backupDueFor(hourUtc, lastDay, now = Date.now()) {
  const hour = Number(hourUtc);
  if (hourUtc === undefined || hourUtc === "" || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const date = new Date(now), day = date.toISOString().slice(0, 10);
  return date.getUTCHours() >= hour && day !== lastDay ? day : null;
}
