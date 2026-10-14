"""
Kolektor intel cacing-naga (Andry Hakim v2), MANDIRI (tidak memakai file data/ hasil clone).
  python collect_intel.py --smoke   uji kecil: 1 halaman keuangan, maks 5 detail
  python collect_intel.py           penuh: ~10 halaman keuangan + detail kandidat DER + pengumuman shortlist
Hasilnya DAFTAR PANTAUAN, bukan sinyal beli.
Publik = Masyarakat Non Warkat. Owner = semua pemegang lain selain Non Warkat dan treasury.
"""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta

from idx.core.client import IDXClient
from idx.scrapers.company import fetch_company_detail
from idx.scrapers.financial import QUERY_PARAMS

# ---- Konstanta (samakan dengan an4_andry_hakim.ts) ----
DER_MAX = 0.1
PUBLIC_MAX_PCT = 30.0
OWNER_MIN_PCT = 70.0
OWNER_MAX_PCT = 99.0
FS_MAX_AGE_DAYS = 183
ANN_MAX_AGE_DAYS = 180
MAX_EMITEN = 60
MAX_DETAIL = 150             # pagar jumlah request detail
SMOKE_DETAIL = 5
SLEEP_S = float(os.environ.get("COLLECT_SLEEP", "1.0"))
FIN_URL = "/DigitalStatistic/GetApiDataPaginated"
ANN_URL = "/NewsAnnouncement/GetAllAnnouncement"

STRONG = re.compile(
    r"akuisisi|pengambilalihan|penambahan modal|private placement|penempatan terbatas|"
    r"fakta material|perubahan pengendali|penyertaan|penjualan aset|pembelian aset|"
    r"transaksi material|perubahan kegiatan usaha|setoran modal|konversi",
    re.I,
)
WEAK = re.compile(
    r"rapat umum pemegang saham luar biasa|rupslb|insidentil|perjanjian|kerja sama|investor",
    re.I,
)
EXCLUDE = re.compile(r"tahunan|registrasi pemegang efek|laporan bulanan", re.I)
NON_PUBLIC_SKIP = ("Masyarakat", "Saham Treasury", "Komisaris", "Direksi")


def pause():
    if SLEEP_S > 0:
        time.sleep(SLEEP_S)


def call(fn, *a, retries=2, **kw):
    """Panggil dengan ulang; None bila gagal atau respons kosong total."""
    for _ in range(retries + 1):
        try:
            r = fn(*a, **kw)
            if r is not None:
                return r
        except Exception:
            pass
        if SLEEP_S > 0:
            time.sleep(2)
    return None


def fin_page(client, y, q, page, size=100):
    p = {**QUERY_PARAMS, "periodQuarter": q, "periodYear": y, "type": "quarterly",
         "pageSize": size, "pageNumber": page}
    d = call(client.get_json, FIN_URL, params=p)
    if d is None:
        return None
    return d.get("data") or []


def pick_period(client, today):
    """Cari periode terbaru yang mayoritas emitennya sudah lapor. Param kuartal bergeser satu
    (Q3 = 30 Jun, Q2 = 31 Mar, Q1 = 31 Des)."""
    answered = False
    for yy in (today.year, today.year - 1):
        for q in (4, 3, 2, 1):
            rows = fin_page(client, yy, q, 1)
            pause()
            if rows is None:
                continue
            answered = True
            if not rows:
                continue
            mode, n = Counter(r.get("fsDate") for r in rows).most_common(1)[0]
            if n >= 50:
                return yy, q, mode
    raise RuntimeError(
        "IDX tidak menjawab (kemungkinan diblokir)" if not answered
        else "Tidak ada periode keuangan dengan data memadai"
    )


def fetch_fin_all(client, y, q, smoke):
    out, page = [], 1
    while True:
        rows = fin_page(client, y, q, page)
        if not rows:
            break
        out.extend(rows)
        print(f"  keuangan halaman {page}: {len(rows)} (total {len(out)})")
        if smoke:
            break
        page += 1
        pause()
    return out


def stage_structure(fin_rows, today):
    cutoff = today - timedelta(days=FS_MAX_AGE_DAYS)
    cands, why = [], {"der": 0, "usang": 0}
    for r in fin_rows:
        code = (r.get("code") or "").strip()
        der = r.get("deRatio")
        if not code or der is None or not (0 <= der <= DER_MAX):
            why["der"] += 1
            continue
        try:
            fs = datetime.strptime(r["fsDate"], "%Y-%m-%d")
        except Exception:
            why["usang"] += 1
            continue
        if fs < cutoff:
            why["usang"] += 1
            continue
        cands.append(r)
    return cands, why


def holders_summary(detail):
    rows = detail.get("PemegangSaham") or []
    non_warkat = sum(r.get("Persentase") or 0 for r in rows if r.get("Kategori") == "Masyarakat Non Warkat")
    warkat = sum(r.get("Persentase") or 0 for r in rows if r.get("Kategori") == "Masyarakat Warkat")
    owner_total = sum(
        r.get("Persentase") or 0
        for r in rows
        if r.get("Kategori") not in ("Masyarakat Non Warkat", "Saham Treasury")
    )
    holders = [r for r in rows if not str(r.get("Kategori", "")).startswith(NON_PUBLIC_SKIP)]
    top = max(holders, key=lambda r: r.get("Persentase") or 0, default=None)
    return non_warkat, warkat, top, owner_total


def stage_holders(r, detail):
    """Kembalikan (item, alasan_gugur)."""
    if not detail or not detail.get("PemegangSaham"):
        return None, "tanpa_detail"
    pub, warkat, top, owner_total = holders_summary(detail)
    if pub > PUBLIC_MAX_PCT:
        return None, "publik"
    if not (OWNER_MIN_PCT <= owner_total <= OWNER_MAX_PCT):
        return None, "owner"
    return {
        "code": (r.get("code") or "").strip(),
        "name": r.get("stockName"),
        "sector": r.get("sector"),
        "fsDate": r["fsDate"],
        "der": r["deRatio"],
        "assetsBn": r.get("assets"),
        "liabilitiesBn": r.get("liabilities"),
        "equityBn": r.get("equity"),
        "profitPeriodBn": r.get("profitPeriod"),
        "audited": r.get("audit"),
        "publicNonWarkatPct": round(pub, 2),
        "publicWarkatPct": round(warkat, 2),
        "ownerTotalPct": round(owner_total, 2),
        "topHolder": {
            "name": (top or {}).get("Nama"),
            "pct": (top or {}).get("Persentase"),
            "controller": bool((top or {}).get("Pengendali")),
        },
    }, None


def fetch_announcements(client, code, today):
    d = call(client.get_json, ANN_URL,
             params={"keywords": code, "pageNumber": 1, "pageSize": 50, "lang": "id"})
    cutoff = today - timedelta(days=ANN_MAX_AGE_DAYS)
    res = []
    for it in (d or {}).get("Items") or []:
        if (it.get("Code") or "").strip() != code:
            continue
        title = (it.get("Title") or "").strip()
        if EXCLUDE.search(title):
            continue
        level = "kuat" if STRONG.search(title) else ("lemah" if WEAK.search(title) else None)
        if level is None:
            continue
        try:
            when = datetime.fromisoformat(it["PublishDate"])
        except Exception:
            continue
        if when < cutoff:
            continue
        main_pdf = next((a for a in it.get("Attachments") or [] if a.get("IsAttachment") == 0), None)
        res.append({"date": it["PublishDate"], "level": level, "title": title,
                    "no": it.get("AnnouncementNo"), "pdf": (main_pdf or {}).get("FullSavePath")})
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="uji kecil")
    ap.add_argument("--out", default="intel.json")
    args = ap.parse_args()

    client = IDXClient()
    today = datetime.now()
    try:
        y, q, fs_mode = pick_period(client, today)
    except RuntimeError as e:
        print("GAGAL:", e)
        return 2
    print(f"Periode terpilih: periodYear={y} periodQuarter={q} (fsDate dominan {fs_mode})")

    fin_rows = fetch_fin_all(client, y, q, args.smoke)
    cands, why = stage_structure(fin_rows, today)
    print(f"Emiten keuangan: {len(fin_rows)} | lolos DER dan usia: {len(cands)} | gugur: {why}")
    cands = cands[: (SMOKE_DETAIL if args.smoke else MAX_DETAIL)]

    items, why2 = [], {"tanpa_detail": 0, "publik": 0, "owner": 0}
    for n, r in enumerate(cands, 1):
        code = (r.get("code") or "").strip()
        detail = call(fetch_company_detail, code, client=client)
        item, reason = stage_holders(r, detail)
        if item:
            items.append(item)
        else:
            why2[reason] += 1
        print(f"  [{n}/{len(cands)}] {code}: {'LOLOS' if item else 'gugur ' + reason}")
        pause()
    print(f"Lolos struktur: {len(items)} | gugur: {why2}")

    items.sort(key=lambda x: x["publicNonWarkatPct"])
    if len(items) > MAX_EMITEN:
        print(f"Peringatan: dibatasi {MAX_EMITEN} (urut publik terkecil).")
        items = items[:MAX_EMITEN]

    for n, it in enumerate(items, 1):
        it["announcements"] = fetch_announcements(client, it["code"], today)
        print(f"  [{n}/{len(items)}] {it['code']}: {len(it['announcements'])} pengumuman relevan")
        pause()

    out = {
        "collectedAt": today.isoformat(timespec="seconds"),
        "financialPeriod": {"periodYear": y, "periodQuarter": q, "fsDate": fs_mode},
        "smoke": bool(args.smoke),
        "publicDefinition": "Masyarakat Non Warkat",
        "note": "Daftar pantauan. Market cap < Rp500 M diperiksa di Worker. Nilai transaksi dan dana masuk dibaca manual dari PDF.",
        "items": items,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("Tersimpan:", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
