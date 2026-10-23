# 05 — Catatan Reverse Engineering & Rencana Bedah APK

Dokumen ini merekam hasil audit teknis artefak yang telah dibongkar serta target dekompilasi selanjutnya.

---

## 1. Temuan dari Dekompilasi APK `nanoMuse` (`nanoMuse-1.0.5-arm64.apk`)

Dibongkar menggunakan tool REA v6.7.0 (`rea extract-artifact`):

- **Arsitektur On-Device:**
  - File `assets/alpine-minirootfs.tar` (8.4 MB) diekstraksi ke filesystem internal ponsel.
  - Menggunakan `libproot.so` dan `libpty_bridge.so` untuk menjalankan shell Alpine Linux di dalam Android tanpa akses root.
- **MCP Client di Android:**
  - Skrip `assets/default_mount/usr/local/bin/minis-mcp-cli` membuktikan bahwa standar MCP (Claude Desktop compatible) dapat dijalankan menggunakan Python3 + `httpx` di lingkungan terminal Linux lokal.
  - File `assets/nanomuse/connectors.json` menyimpan konfigurasi 75 server remote MCP siap pakai.
- **Kesimpulan untuk SaaS Kita:**
  - nanoMuse membuktikan bahwa antarmuka mobile agent dapat mengelola task, connector, dan approval card dengan sangat rapi.
  - Namun, karena nanoMuse menggunakan lisensi GPL-3.0 dan menjalankan Linux di dalam ponsel (yang berat dan tidak cocok untuk server processing dokumen legal), kita mengadopsi konsep UX-nya secara *Clean-Room* ke dalam basis kode OpenBot (MIT).

---

## 2. Temuan dari Bedah Repositori `CopilotKit/OpenBot`

- **Sistem Autentikasi & Database:**
  - Menggunakan Drizzle ORM + PostgreSQL (`0000_schema.sql`).
  - Tabel `channels` dan `agent_profiles` sudah mendukung konsep *visibility* (`public` vs `private`), yang secara langsung memetakan kebutuhan *Team Workspace* vs *Personal Workspace*.
  - Tabel `action_policy` dan `audit_events` (append-only) menyediakan pondasi kepatuhan hukum (*audit compliance*) yang sangat kuat.
- **Sistem Agent Computer:**
  - Menggunakan Bun + Playwright Chromium.
  - Keamanan workspace (`workspace.ts`) memiliki pencegahan *directory traversal* 3 lapis yang sudah teruji.
- **Mobile Client (`mobile/`):**
  - Berbasis React Native (Expo) dengan konfigurasi multi-platform (`app.config.ts`, `eas.json`).
  - Siap dikustomisasi menjadi aplikasi Android APK mandiri tanpa ketergantungan copyleft GPL.

---

## 3. Rencana Bedah Target Lanjutan: APK Legal Hero (`com.legalhero`)

Tujuan pembongkaran APK Legal Hero di tahap berikutnya:
1. **Analisis Skema Data Putusan MA:**
   - Meneliti struktur payload JSON yang diterima aplikasi saat mencari dasar hukum.
   - Mengambil inspirasi taksonomi filter perkara (Klasifikasi perkara, kamar peradilan, tingkat putusan).
2. **System Prompt & Review Flow:**
   - Meneliti prompt template yang digunakan untuk fitur *Legal Drafting* dan *Document Review* versi aplikasi mobile.
3. **Penyusunan Format API Internal:**
   - Menyelaraskan format respons Centralized Legal DB kita agar familiar dan sesuai dengan standar yang diharapkan oleh praktisi hukum di Indonesia.
