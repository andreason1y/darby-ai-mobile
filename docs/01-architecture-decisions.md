# 01 — Keputusan Arsitektur & Fondasi Sistem

Dokumen ini mencatat keputusan fundamental mengenai arsitektur sistem, model isolasi, dan strategi lisensi Legal Agent SaaS.

---

## 1. Cloud-VM Agent vs On-Device Agent

- **Pilihan:** Cloud-VM Agent (Server-driven).
- **Alasan:**
  - Pemrosesan dokumen legal (parsing 200 PDF data room, komparasi ribuan klausul, OCR, rendering DOCX Track Changes) membutuhkan daya komputasi tinggi dan RAM besar yang tidak realistis dibebankan ke ponsel user.
  - Ponsel user berfungsi sebagai **Thin Client** (chat, status progress, preview hasil, dan kartu persetujuan/approval).
  - Model eksekusi tetap berjalan saat aplikasi di ponsel user ditutup (*persistent background jobs*).

---

## 2. Shared Compute Pool vs Dedicated VM Per-User

- **Pilihan:** Shared Compute Pool dengan Ephemeral Task Containers.
- **Problem Model Dedicated (Muse/Grok Bot):**
  - Memberikan 1 full VM/container 24/7 per user membakar biaya server sebelum cashflow stabil.
  - Beban kerja hukum bersifat *bursty*: lawyer mengunggah dokumen tebal, menunggu 3-5 menit proses selesai, lalu idle selama beberapa jam.
- **Solusi Arsitektur:**
  - Container `agent-computer` di-spawn dari pool worker yang dikelola oleh `supervisor`.
  - Container hanya aktif selama eksekusi task dan otomatis sleep/terminate saat idle.
  - Resource komputasi (CPU/RAM) digunakan bersama secara efisien tanpa pembengkakan biaya infrastruktur.

---

## 3. Model Isolasi Data: Personal vs Team Workspace

Hardware komputasi boleh di-share, tetapi **data tenant wajib terisolasi 100%**.

- **Batas Isolasi:** Terletak pada **lapisan mount storage volume**, bukan pada runtime kernel shared.
- **Tingkatan Workspace:**
  1. **Personal Workspace (Solo Practitioner):**
     - Direktori volume terenkripsi khusus user id: `/tenants/users/{user_id}/workspace`.
     - Dokumen perkara, catatan, dan preferensi tidak terlihat oleh pihak mana pun.
  2. **Team / Firm Workspace (Law Firm & In-House):**
     - Direktori volume bersama per firma/organisasi: `/tenants/firms/{firm_id}/workspace`.
     - Berbagi *Standard Playbook*, template klausul, dan data room perkara antar-lawyer dalam tim.
     - Didukung oleh RBAC (`firm_admin`, `partner`, `associate`, `paralegal`).
- **Mekanisme Eksekusi:**
  - Ketika sebuah task masuk, supervisor mengambil container worker dari pool.
  - Storage volume tenant yang bersangkutan di-mount ke `/workspace` container.
  - Tiga lapis *path confinement* (dari `workspace.ts` OpenBot) memastikan bot tidak bisa mengakses direktori di luar volume tenant tersebut.
  - Setelah task tuntas, volume di-unmount dan container dibersihkan.

---

## 4. Strategi Lisensi & Basis Kode (MIT vs GPL)

- **Keputusan:** Basis kode inti mengadopsi `CopilotKit/OpenBot` (**MIT License**).
- **Analisis Risiko:**
  - `nanoMuse` dan `OpenMinis` menggunakan lisensi **GPL-3.0**. Mendistribusikan aplikasi mobile/APK komersial dari turunan GPL-3.0 mewajibkan seluruh kode aplikasi mobile dibuka ke publik (copyleft).
  - `CopilotKit/OpenBot` berlisensi **MIT**, memberikan kebebasan 100% untuk membangun SaaS komersial dengan klien mobile berlisensi tertutup (*proprietary*).
- **Clean-Room Reverse Engineering:**
  - Binary dan APK GPL-3.0 (seperti nanoMuse) atau closed-source (Meta Muse / Legal Hero) hanya dijadikan objek riset untuk mengekstrak spesifikasi, alur socket, dan skema JSON.
  - Implementasi kode ditulis ulang dari awal sehingga hak cipta tetap bersih dan proprietary.
