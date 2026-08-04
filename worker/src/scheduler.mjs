// Replaces the n8n Schedule Trigger: n8n added no logic here, only a daily HTTP call, and
// existed purely to justify running Postgres as its backing store (see docs/decisions.md).
// Polls every checkIntervalMs and fires `run()` once per UTC calendar day during hourUtc.
// In-memory-only lastRunDate is a deliberate simplification for a personal single-daily job —
// a restart mid-window could re-trigger once, which the pipeline's own dedup already tolerates.
export const startDailyScheduler = ({ run, hourUtc = 7, checkIntervalMs = 15 * 60 * 1000, now = () => new Date(), scheduleImpl = setInterval, log = console }) => {
  let lastRunDate = null;

  const tick = async () => {
    const current = now();
    const today = current.toISOString().slice(0, 10);
    if (current.getUTCHours() !== hourUtc || lastRunDate === today) return null;
    lastRunDate = today;
    try {
      const result = await run();
      log.log(`Daily discovery run completed for ${today}.`);
      return result;
    } catch (error) {
      log.error(`Daily discovery run failed for ${today}: ${error.message}`);
      return null;
    }
  };

  const timer = scheduleImpl(tick, checkIntervalMs);
  return { stop: () => clearInterval(timer), tick };
};
