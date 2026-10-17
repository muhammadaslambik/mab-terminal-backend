// Pemeriksa kesehatan harian: kirim email bila ada cron basi/gagal. Sehat = tidak ada email.
import { readHeartbeats } from "./heartbeat";

export async function runHealthAlert(env: any): Promise<void> {
  const h = await readHeartbeats(env);
  const bad = h.crons.filter((c) => c.state === "basi" || c.state === "gagal");
  if (bad.length === 0) return;
  const { notificationConfigured, sendNotification } = await import("../notify/alert");
  if (!notificationConfigured(env)) {
    console.error("Health check: ada cron bermasalah tetapi saluran email belum dikonfigurasi");
    return;
  }
  const lines = bad.map((c) =>
    c.state === "gagal"
      ? `- ${c.name}: GAGAL pada ${c.lastRunAt} (${c.error ?? "tanpa pesan"})`
      : `- ${c.name}: BASI, terakhir jalan ${c.lastRunAt} (${c.ageMin} menit lalu, batas ${c.maxAgeMin})`
  );
  await sendNotification(
    env,
    "MAB-Terminal: cron bermasalah",
    `Pemeriksaan ${h.now}\n${lines.join("\n")}\n\nCek /api/health (dengan token) untuk rincian.`
  );
}
