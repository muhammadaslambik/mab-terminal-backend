import type { Engine } from "./types";
import { anstdBaseline } from "./anstd_baseline";
import { an1Astronacci } from "./an1_astronacci";
import { an2Kalimasada } from "./an2_kalimasada";
import { an3Remora } from "./an3_remora";
import { an4V1, an4V2, an4V3 } from "./an4_andry_hakim";

/** Daftar engine aktif. Hapus/komentari baris untuk menonaktifkan satu engine. */
export const engines: Engine[] = [anstdBaseline, an1Astronacci, an2Kalimasada, an3Remora, an4V1, an4V2, an4V3];
