# Darby AI — Autonomous Legal Intelligence Platform

**Darby AI** adalah SaaS AI Legal Intelligence berarsitektur **Cloud-VM Agent** dengan cangkang **Mobile (Android APK)** dan antarmuka **Virtual Legal Coworkers** (multi-agent coworker ala Grok Bot / OpenBot).

Dibangun khusus untuk ekosistem hukum Indonesia:
1. **Corporate In-House Legal** (Head of Legal, Legal Manager, Staff Legal / Specialist)
2. **Law Firm & LBH** (Managing Partner, Partner, Associate, Paralegal)
3. **Solo Practitioner** (Advokat Mandiri)

---

## Prinsip Arsitektur Utama (Non-Negotiable)

1. **Shared Compute Pool, Strict Data Isolation:**
   - Resource hardware (CPU/RAM container VM) dipakai bersama secara efisien via worker/task pool.
   - Data tenant (dokumen perkara, draf kontrak, catatan) 100% terisolasi per user/firm dan hanya di-mount saat task aktif.
2. **Centralized Proprietary Legal DB (The Moat):**
   - Database hukum terkurasi (Putusan MA, Peraturan Perundang-undangan UU/PP/Permen, JDIH, Yurisprudensi) di-hosting sendiri di Cloudflare R2 + Hybrid Vector Search.
   - Bukan scraping live saat runtime (anti-blokir & anti-timeout).
   - Agent roaming (browser) hanya sebagai pelengkap info real-time yang belum masuk corpus.
3. **Pondasi Lisensi Komersial Bersih (MIT):**
   - Menggunakan basis arsitektur `CopilotKit/OpenBot` (MIT License) untuk client mobile, supervisor, dan server gateway.
   - Menghindari copyleft GPL-3.0 (nanoMuse) untuk binary APK komersial closed-source.
4. **Fitur Mengacu Benchmark Global (Harvey & Ivo):**
   - Prioritas MVP #1: Contract Review & Surgical Redline (Track Changes DOCX via Playbook).
   - Prioritas MVP #2: Grounded Legal Research dengan sitasi terverifikasi (Zero Hallucination).

---

## Struktur Dokumentasi Konteks

- [`docs/01-architecture-decisions.md`](docs/01-architecture-decisions.md): Keputusan arsitektur VM, workspace multi-tenant, dan strategi lisensi.
- [`docs/02-centralized-legal-db.md`](docs/02-centralized-legal-db.md): Desain dan strategi Centralized Legal Database (R2 + Vector) & benchmark Legal Hero.
- [`docs/03-feature-roadmap.md`](docs/03-feature-roadmap.md): Taksonomi fitur Harvey, Ivo, dan prioritas MVP Indonesia.
- [`docs/04-agent-computer-spec.md`](docs/04-agent-computer-spec.md): Spesifikasi container `agent-computer`, toolchain legal (Python, docx, OCR), dan modifikasi pool supervisor.
- [`docs/05-reverse-engineering-notes.md`](docs/05-reverse-engineering-notes.md): Catatan teknis hasil bedah APK nanoMuse, OpenBot, dan roadmap RE APK Legal Hero.
- [`docs/06-team-firm-architecture.md`](docs/06-team-firm-architecture.md): Struktur firma, LBH, in-house, solo, matriks peran, dan isolasi matter vault.
